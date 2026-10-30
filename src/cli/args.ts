import {
  CliOptionsSchema,
  OutputFormatSchema,
  TddPhaseSchema,
  type CliOptions,
} from "../types/schema.js";

export const EX_USAGE = 64;

export class UsageError extends Error {
  readonly exitCode = EX_USAGE;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface RunParseResult {
  kind: "run";
  options: CliOptions;
  command: string[];
}

export type ParseResult = RunParseResult | { kind: "help" } | { kind: "version" };

export const USAGE = `dot-test-digest — bounded test/build output compressor

Usage: dot-test-digest [flags] -- <command ...>

Flags (everything after -- is passed to <command> verbatim):
  --tdd-phase <red|green|refactor|none>   phase gate (default: none)
  --format <compact-md|json>              stdout format (default: compact-md)
  --max-clusters <1..15>                  clusters emitted on failure (default: 5)
  --context-lines <0..5>                  SignalWindow half-height (default: 2)
  --scope-id <string>                     TDD state scope (default: sha256(cwd)[0..12])
  --retry-flakes                          retry once when Gear 1 is >=0.80 sure it is a flake
  --no-jev                                never call the Jev API (offline)
  -h, --help                              show this help
  -v, --version                           show the version

Environment:
  TYPESAFE_API_KEY, TYPESAFE_API_URL, DOT_TEST_DIGEST_HOME
`;

function readFlagValue(argv: readonly string[], index: number, flag: string): [string, number] {
  const token = argv[index] ?? "";
  const equals = token.indexOf("=");
  if (equals !== -1) return [token.slice(equals + 1), index];
  const value = argv[index + 1];
  if (value === undefined || value === "--") {
    throw new UsageError(`${flag} requires a value`);
  }
  return [value, index + 1];
}

function readInt(flag: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`${flag} must be an integer, got ${raw}`);
  if (value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const raw: Record<string, unknown> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;

    if (token === "--") {
      const command = argv.slice(index + 1);
      if (command.length === 0) throw new UsageError("no command after --");
      return { kind: "run", options: validate(raw), command };
    }
    if (token === "--help" || token === "-h") return { kind: "help" };
    if (token === "--version" || token === "-v") return { kind: "version" };

    // A bare positional before `--` means the caller forgot the delimiter; say so
    // instead of reporting it as an unknown flag.
    if (!token.startsWith("-")) {
      throw new UsageError(
        `missing -- delimiter before "${token}": dot-test-digest [flags] -- <command>`,
      );
    }

    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;

    switch (flag) {
      case "--tdd-phase": {
        const [value, next] = readFlagValue(argv, index, flag);
        const parsed = TddPhaseSchema.safeParse(value);
        if (!parsed.success) throw new UsageError(`${flag} must be red, green, refactor or none`);
        raw["tddPhase"] = parsed.data;
        index = next;
        break;
      }
      case "--format": {
        const [value, next] = readFlagValue(argv, index, flag);
        const parsed = OutputFormatSchema.safeParse(value);
        if (!parsed.success) throw new UsageError(`${flag} must be compact-md or json`);
        raw["format"] = parsed.data;
        index = next;
        break;
      }
      case "--max-clusters": {
        const [value, next] = readFlagValue(argv, index, flag);
        raw["maxClusters"] = readInt(flag, value, 1, 15);
        index = next;
        break;
      }
      case "--context-lines": {
        const [value, next] = readFlagValue(argv, index, flag);
        raw["contextLines"] = readInt(flag, value, 0, 5);
        index = next;
        break;
      }
      case "--scope-id": {
        const [value, next] = readFlagValue(argv, index, flag);
        raw["scopeId"] = value;
        index = next;
        break;
      }
      case "--no-jev":
        raw["noJev"] = true;
        break;
      case "--retry-flakes":
        raw["retryFlakes"] = true;
        break;
      default:
        throw new UsageError(`unknown flag: ${flag}`);
    }
  }

  throw new UsageError("missing -- delimiter: dot-test-digest [flags] -- <command>");
}

function validate(raw: Record<string, unknown>): CliOptions {
  const parsed = CliOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(`${issue?.path.join(".") ?? "options"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
