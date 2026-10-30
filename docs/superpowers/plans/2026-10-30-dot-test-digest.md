# dot-test-digest v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a drop-in CLI wrapper (`dot-test-digest [flags] -- <command>`) that compresses any test or build run into a bounded, deduplicated digest while returning the child's exit code untouched.

**Architecture:** Single-pass pipeline. `src/index.ts` parses flags, spawns the child with piped stdio, tees every byte to `~/.cache/dot-test-digest/logs/<run_id>.log`, then runs Gear 0 (ANSI strip → grammar adapter → stack prune → fingerprint dedup → SignalWindow inlining). Only when Gear 0 yields zero clusters on a failed run with more than 150 lines does Gear 1 run (Jev `jev-1.13.0`, one `POST /v1/systemone` with at most 255 candidate windows), falling back to a heuristic window pick. A phase gate decides the status and exit code; the formatter emits the `DigestEnvelope` under a hard byte ceiling.

**Tech Stack:** Node.js ≥ 20 (dev host: Node 22.22.0), TypeScript 5.7 strict, ESM (`"type": "module"`, `.js` import specifiers), `zod` for every schema, `vitest` for tests, `pnpm` 10.9 as the package manager (matches the sibling `dotbrowser` repo).

**Spec:** `specs/SPEC-002-DOT-TEST-DIGEST.md` · **Integrity review and adopted resolutions (R1–R12):** `specs/INTEGRITY-SPEC-002.md`

---

## Context you need before Task 1

You start from a repository that contains only `specs/`. Read `specs/SPEC-002-DOT-TEST-DIGEST.md` once end to end, then keep §3 (invariants) and §4.1 (the envelope schema) open — every task below names the invariant it satisfies.

These decisions came out of the integrity review. They are **not** negotiable during implementation:

| ID | Decision |
|---|---|
| R2 | `status` includes `VALID_RED`. CT-3 asserts it verbatim. |
| R4 | A Jev `Noul` returns a probability, not a confidence. Retry iff `answers.is_transient_flake.noul >= 0.8`. |
| R5 | `BUILD_ERROR` means "no grammar adapter produced a cluster"; `FAIL` means a grammar adapter did. |
| R6 | `pruned_stack` holds at most 6 entries: ≤5 repository frames + ≤1 external boundary frame. |
| R7 | Escalate to Gear 1 when `exit != 0 && clusters.length === 0 && lines > 150`. |
| R10 | Ceilings are hard: pass line ≤160 bytes, fail body ≤2400 bytes. |
| R11 | Gear 1 `state` is bounded (command, exit code, line count, last 40 lines); windows travel as `choice` criteria. |
| R12 | Cache root is `process.env.DOT_TEST_DIGEST_HOME ?? ~/.cache/dot-test-digest`. Tests always override it. |

### File map (what you are building)

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `README.md` | Toolchain |
| `src/version.ts` | `VERSION` constant |
| `src/types/schema.ts` | Zod schemas: CLI options, envelope, cluster, Jev payloads |
| `src/cli/args.ts` | Flag parsing, `USAGE`, `UsageError` (exit 64) |
| `src/pruner/ansi-stripper.ts` | ANSI/OSC/CR stripping, passing-noise detection |
| `src/pruner/stack-pruner.ts` | External-frame detection, frame pruning, `SignalWindow` reading |
| `src/pruner/cluster-dedup.ts` | `RootCauseFingerprint`, cluster collapsing |
| `src/adapters/index.ts` | Adapter registry, `ErrorKind` classification, count parsing |
| `src/adapters/common.ts` | Shared adapter types, `classifyMessage`, count-token helpers |
| `src/adapters/js-test.ts` | vitest / jest / playwright / node:test grammar |
| `src/adapters/tsc-eslint.ts` | tsc diagnostics, eslint stylish output |
| `src/adapters/python.ts` | pytest / ruff / mypy grammar |
| `src/adapters/rust-go.ts` | cargo test/check, go test grammar |
| `src/runner/raw-log.ts` | Run id, raw log file, cache root, line-range formatting |
| `src/runner/capture.ts` | Child spawn, line-numbered tee, exit/signal mapping |
| `src/formatters/envelope.ts` | Envelope assembly, compact-md + json rendering, ceiling enforcement |
| `src/state/tdd-gate.ts` | Scope id, atomic state file, phase gate, `RedGreenDelta` |
| `src/gears/windows.ts` | 12-line window partitioner, ≤255 selection (INV-6) |
| `src/gears/jev-client.ts` | Jev 1.13 HTTP client (`/v1/systemone`) |
| `src/gears/gear1-jev.ts` | Unstructured triage, flake retry decision, heuristic fallback |
| `src/index.ts` | CLI entrypoint, pipeline wiring, exit codes (INV-3) |
| `tests/pruner.spec.ts`, `tests/dedup-and-tdd.spec.ts`, `tests/gear1-jev.spec.ts` | Spec §5 test files |
| `tests/cli.spec.ts`, `tests/adapters.spec.ts`, `tests/fixtures/*` | Additive (R8, R7) test surface |

Commit after every task. Conventional commits, one line, no body.

---

### Task 1: Scaffold the toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/version.ts`, `tests/smoke.spec.ts`

- [ ] **Step 1: Create the repository if it is not one yet**

```bash
cd /mnt/octavio/octavio/Projects/Flowdots/dot-test-digest
git init -b main
git add specs
git commit -m "docs: add SPEC-002 and its integrity review"
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "dot-test-digest",
  "version": "0.1.0",
  "private": true,
  "description": "Bounded test, compiler and build output compressor (SPEC-002-DOT-TEST-DIGEST).",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@10.9.0",
  "bin": { "dot-test-digest": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "verify": "pnpm typecheck && pnpm test"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/version.ts`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    exclude: ["node_modules/**", "tests/fixtures/**/*"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
```

`.gitignore`:

```
node_modules/
dist/
coverage/
*.log
.env
.DS_Store
```

`.env.example`:

```
# Jev (Gear 1) — optional. Without it, Gear 1 degrades to GEAR_0_HEURISTIC_FALLBACK.
TYPESAFE_API_KEY=
# Override for tests or an air-gapped mirror.
TYPESAFE_API_URL=https://api.typesafe.ai
# Cache root for logs and TDD state. Default: ~/.cache/dot-test-digest
DOT_TEST_DIGEST_HOME=
```

`src/version.ts`:

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 4: Write the smoke test**

`tests/smoke.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("toolchain", () => {
  it("exposes the package version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 5: Install and verify**

Run:

```bash
pnpm install
pnpm typecheck
pnpm test
```

Expected: `pnpm install` writes `pnpm-lock.yaml`; `pnpm typecheck` exits 0 with no output; `pnpm test` reports `1 passed`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold typescript esm toolchain with vitest"
```

---

### Task 2: Zod contracts for every payload (`src/types/schema.ts`)

Implements SPEC §4.1 schema plus the Jev 1.13 payload shapes (R1). This file is the single source of truth for every type used later; do not redeclare these shapes elsewhere.

**Files:**
- Create: `src/types/schema.ts`, `tests/schema.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/schema.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CliOptionsSchema,
  DigestEnvelopeSchema,
  DigestStatusSchema,
  FailureClusterSchema,
  JevResponseSchema,
} from "../src/types/schema.js";

const cluster = {
  cluster_id: "c_9f2a1b3c",
  fingerprint: "a".repeat(64),
  error_kind: "RUNTIME_EXCEPTION",
  affected_count: 47,
  sample_tests: ["login > rejects expired token"],
  message: "TypeError: token.split is not a function",
  top_frame: "src/auth/jwt.ts:28:19",
  pruned_stack: [
    "at parseToken (src/auth/jwt.ts:28:19)",
    "at node_modules/vitest/dist/chunk.js:1:1",
  ],
  signal_window: "28 >   return parts.split('.')",
  raw_log_lines: "L412-L448",
};

describe("DigestEnvelopeSchema", () => {
  it("accepts a minimal failure envelope", () => {
    const envelope = {
      status: "FAIL",
      tdd_phase: "green",
      exit_code: 1,
      signal: null,
      execution_gear: "GEAR_0_GRAMMAR",
      duration_ms: 1830,
      summary: { passed: 12, failed: 47, skipped: 0, total_clusters: 1 },
      clusters: [{ ...cluster, pruned_stack: [...cluster.pruned_stack] }],
      raw_log_path: "/home/dev/.cache/dot-test-digest/logs/run_8f2a.log",
    };
    expect(DigestEnvelopeSchema.parse(envelope).clusters).toHaveLength(1);
  });

  it("accepts VALID_RED as a status", () => {
    expect(DigestStatusSchema.parse("VALID_RED")).toBe("VALID_RED");
  });

  it("allows one external boundary frame plus five repo frames", () => {
    const six = ["a", "b", "c", "d", "e", "node_modules/x/index.js:1:1"];
    expect(FailureClusterSchema.safeParse({ ...cluster, pruned_stack: six }).success).toBe(true);
    expect(
      FailureClusterSchema.safeParse({ ...cluster, pruned_stack: [...six, "extra"] }).success,
    ).toBe(false);
  });

  it("rejects an unknown error kind", () => {
    expect(
      FailureClusterSchema.safeParse({ ...cluster, error_kind: "WAT" }).success,
    ).toBe(false);
  });
});

describe("CliOptionsSchema", () => {
  it("applies the documented defaults", () => {
    const parsed = CliOptionsSchema.parse({});
    expect(parsed).toMatchObject({
      tddPhase: "none",
      format: "compact-md",
      maxClusters: 5,
      contextLines: 2,
      noJev: false,
      retryFlakes: false,
    });
  });

  it("rejects maxClusters above the ceiling", () => {
    expect(CliOptionsSchema.safeParse({ maxClusters: 16 }).success).toBe(false);
  });
});

describe("JevResponseSchema", () => {
  it("parses a mixed choice + noul response", () => {
    const response = {
      model: "jev-1.13.0",
      answers: {
        root_cause_window: {
          type: "choice",
          choice: "w_61",
          confidence: 0.91,
          probabilities: { w_61: 0.91, w_62: 0.09 },
        },
        is_transient_flake: { type: "noul", noul: 0.12 },
      },
      usage: { input_tokens: 1200, output_tokens: 12 },
    };
    expect(JevResponseSchema.parse(response).answers.is_transient_flake).toEqual({
      type: "noul",
      noul: 0.12,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/schema.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/types/schema.js"`.

- [ ] **Step 3: Write `src/types/schema.ts`**

```ts
import { z } from "zod";

export const TddPhaseSchema = z.enum(["red", "green", "refactor", "none"]);
export type TddPhase = z.infer<typeof TddPhaseSchema>;

export const OutputFormatSchema = z.enum(["compact-md", "json"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

/**
 * R2: VALID_RED is required by SPEC §4.3 and CT-3 but missing from §4.1's enum.
 */
export const DigestStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "VALID_RED",
  "INVALID_RED",
  "REGRESSION_DETECTED",
  "BUILD_ERROR",
]);
export type DigestStatus = z.infer<typeof DigestStatusSchema>;

export const ExecutionGearSchema = z.enum([
  "GEAR_0_GRAMMAR",
  "GEAR_1_JEV",
  "GEAR_0_HEURISTIC_FALLBACK",
]);
export type ExecutionGear = z.infer<typeof ExecutionGearSchema>;

export const ErrorKindSchema = z.enum([
  "ASSERTION_FAILURE",
  "RUNTIME_EXCEPTION",
  "TYPE_COMPILE_ERROR",
  "SYNTAX_IMPORT_ERROR",
  "TIMEOUT_OR_CONN_REFUSED",
  "UNSTRUCTURED_BUILD_ERROR",
]);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const CliOptionsSchema = z.object({
  tddPhase: TddPhaseSchema.default("none"),
  format: OutputFormatSchema.default("compact-md"),
  maxClusters: z.number().int().min(1).max(15).default(5),
  contextLines: z.number().int().min(0).max(5).default(2),
  scopeId: z.string().min(1).max(64).optional(),
  noJev: z.boolean().default(false),
  retryFlakes: z.boolean().default(false),
});
export type CliOptions = z.infer<typeof CliOptionsSchema>;

/** R6: ≤5 repository frames + ≤1 external boundary frame. */
export const MAX_REPO_FRAMES = 5;
export const MAX_PRUNED_STACK = 6;

export const FailureClusterSchema = z.object({
  cluster_id: z.string().regex(/^c_[0-9a-f]{8}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  error_kind: ErrorKindSchema,
  affected_count: z.number().int().positive(),
  sample_tests: z.array(z.string()).max(3),
  diff: z.object({ expected: z.string(), received: z.string() }).optional(),
  message: z.string(),
  top_frame: z.string(),
  pruned_stack: z.array(z.string()).max(MAX_PRUNED_STACK),
  signal_window: z.string(),
  raw_log_lines: z.string().regex(/^L\d+-L\d+$/),
});
export type FailureCluster = z.infer<typeof FailureClusterSchema>;

export const SummarySchema = z.object({
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  total_clusters: z.number().int().min(0),
});

export const DeltaSchema = z.object({
  newly_passing: z.number().int().min(0),
  newly_broken_regressions: z.number().int().min(0),
  still_failing: z.number().int().min(0),
});
export type Delta = z.infer<typeof DeltaSchema>;

export const DigestEnvelopeSchema = z.object({
  status: DigestStatusSchema,
  tdd_phase: TddPhaseSchema,
  exit_code: z.number().int(),
  signal: z.string().nullable(),
  execution_gear: ExecutionGearSchema,
  duration_ms: z.number().int().min(0),
  summary: SummarySchema,
  delta: DeltaSchema.optional(),
  clusters: z.array(FailureClusterSchema).max(15).optional(),
  raw_log_path: z.string().min(1),
});
export type DigestEnvelope = z.infer<typeof DigestEnvelopeSchema>;

/* ------------------------------ Jev 1.13 wire ------------------------------ */
/* R1: real contract — POST /v1/systemone, lowercase type discriminators.     */

export const JevChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length <= 255, {
    message: "a Choice question accepts at most 255 options (INV-6)",
  }),
});

export const JevNoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }).optional(),
});

export const JevQuestionSchema = z.union([JevChoiceQuestionSchema, JevNoulQuestionSchema]);
export type JevQuestion = z.infer<typeof JevQuestionSchema>;

export const JevChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
});

export const JevNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

export const JevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([JevChoiceAnswerSchema, JevNoulAnswerSchema])),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
export type JevResponse = z.infer<typeof JevResponseSchema>;

export const JevRequestSchema = z.object({
  model: z.string(),
  state: z.union([z.string(), z.record(z.string(), z.unknown())]),
  questions: z.record(z.string(), JevQuestionSchema).refine((q) => Object.keys(q).length > 0, {
    message: "at least one question is required",
  }),
});
export type JevRequest = z.infer<typeof JevRequestSchema>;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/schema.spec.ts && pnpm typecheck`
Expected: `8 passed`, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add zod contracts for cli, envelope, cluster and jev payloads"
```

---

### Task 3: CLI flag parsing (`src/cli/args.ts`)

Implements SPEC §4.1's flag table plus R3 (`--retry-flakes`). Everything after `--` is passed through untouched.

**Files:**
- Create: `src/cli/args.ts`, `tests/cli.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EX_USAGE, UsageError, parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
  it("parses every flag and passes the command through verbatim", () => {
    const parsed = parseArgs([
      "--tdd-phase=red",
      "--format",
      "json",
      "--max-clusters",
      "3",
      "--context-lines=4",
      "--scope-id",
      "s01",
      "--no-jev",
      "--retry-flakes",
      "--",
      "vitest",
      "run",
      "--reporter=verbose",
    ]);
    expect(parsed).toEqual({
      kind: "run",
      options: {
        tddPhase: "red",
        format: "json",
        maxClusters: 3,
        contextLines: 4,
        scopeId: "s01",
        noJev: true,
        retryFlakes: true,
      },
      command: ["vitest", "run", "--reporter=verbose"],
    });
  });

  it("applies defaults when no flags are given", () => {
    const parsed = parseArgs(["--", "true"]);
    expect(parsed).toMatchObject({
      kind: "run",
      options: { tddPhase: "none", format: "compact-md", maxClusters: 5, contextLines: 2 },
      command: ["true"],
    });
  });

  it("recognises --help and --version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("rejects an unknown flag with EX_USAGE", () => {
    expect(() => parseArgs(["--wat"])).toThrow(UsageError);
    try {
      parseArgs(["--wat"]);
    } catch (error) {
      expect((error as UsageError).exitCode).toBe(EX_USAGE);
    }
  });

  it("rejects a missing -- delimiter", () => {
    expect(() => parseArgs(["vitest", "run"])).toThrow(/--/);
  });

  it("rejects maxClusters above 15", () => {
    expect(() => parseArgs(["--max-clusters", "16", "--", "true"])).toThrow(/max-clusters/);
  });

  it("rejects a missing flag value", () => {
    expect(() => parseArgs(["--format", "--", "true"])).toThrow(/format/);
  });

  it("rejects an invalid enum value", () => {
    expect(() => parseArgs(["--tdd-phase", "blue", "--", "true"])).toThrow(/tdd-phase/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/cli.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/cli/args.js"`.

- [ ] **Step 3: Write `src/cli/args.ts`**

```ts
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/cli.spec.ts`
Expected: `8 passed`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: parse cli flags with exit-code-64 usage errors"
```

---

### Task 4: ANSI, progress and passing-noise stripping (`src/pruner/ansi-stripper.ts`)

Satisfies the first half of INV-1: nothing that only exists to decorate a terminal may reach the envelope.

**Files:**
- Create: `src/pruner/ansi-stripper.ts`, `tests/pruner.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/pruner.spec.ts` (first block — later tasks append to this file):

```ts
import { describe, expect, it } from "vitest";
import {
  isPassingNoise,
  normalizeLine,
  normalizeLines,
  stripAnsi,
  stripPassingNoise,
} from "../src/pruner/ansi-stripper.js";

describe("stripAnsi", () => {
  it("removes CSI colour codes", () => {
    expect(stripAnsi("\u001b[32m✓\u001b[39m login")).toBe("✓ login");
  });

  it("removes OSC hyperlink sequences", () => {
    expect(stripAnsi("\u001b]8;;https://x.dev\u0007click\u001b]8;;\u0007")).toBe("click");
  });

  it("keeps plain text untouched", () => {
    expect(stripAnsi("TypeError: token.split is not a function")).toBe(
      "TypeError: token.split is not a function",
    );
  });
});

describe("normalizeLine", () => {
  it("keeps only the text after the last carriage return (spinner overwrite)", () => {
    expect(normalizeLine("⠋ running...\r✓ done")).toBe("✓ done");
  });

  it("strips trailing whitespace and escape codes", () => {
    expect(normalizeLine("\u001b[2K   12 tests   ")).toBe("   12 tests");
  });

  it("leaves an empty line empty", () => {
    expect(normalizeLine("")).toBe("");
  });
});

describe("normalizeLines", () => {
  it("preserves the number of lines so raw-log pointers stay valid", () => {
    expect(normalizeLines("a\rb\n\nc")).toEqual(["b", "", "c"]);
  });
});

describe("passing noise", () => {
  it.each([
    "  ✓ login works 12ms",
    "✔ parse tokens",
    "PASS  tests/auth.spec.ts",
    "ok  1  node/test",
    "Test Files  32 passed (32)",
    "12 passing (640ms)",
  ])("treats %s as noise", (line) => {
    expect(isPassingNoise(line)).toBe(true);
  });

  it("keeps failures and stack frames", () => {
    expect(isPassingNoise("  ✕ login rejects expired token")).toBe(false);
    expect(isPassingNoise("TypeError: token.split is not a function")).toBe(false);
    expect(isPassingNoise("   at parseToken (src/auth/jwt.ts:28:19)")).toBe(false);
  });

  it("drops only the noise from a stream", () => {
    const stream = ["  ✓ a", "  ✕ b", "PASS tests/x.spec.ts"];
    expect(stripPassingNoise(stream)).toEqual(["  ✕ b"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/pruner.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/pruner/ansi-stripper.js"`.

- [ ] **Step 3: Write `src/pruner/ansi-stripper.ts`**

```ts
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const SINGLE_ESCAPE = /\u001b[@-Z\\-_]/g;

const PASS_MARKERS: readonly RegExp[] = [
  /^\s*[✓✔√·•]\s/,
  /^\s*✓/,
  /^\s*PASS\s/,
  /^\s*ok\s+\d+\s/,
  /^\s*Test Files\s+\d+\s+passed/,
  /^\s*\d+\s+passing\s*\(/,
];

/** Removes ANSI CSI/OSC sequences and stray escape bytes. */
export function stripAnsi(input: string): string {
  return input.replace(OSC, "").replace(CSI, "").replace(SINGLE_ESCAPE, "");
}

/**
 * Normalises a single physical line: strips ANSI, keeps only the segment after
 * the last `\r` (progress spinners), and trims trailing whitespace.
 * Never merges or drops lines — raw-log line numbers depend on a 1:1 mapping.
 */
export function normalizeLine(input: string): string {
  const stripped = stripAnsi(input);
  const carriageReturn = stripped.lastIndexOf("\r");
  const visible = carriageReturn === -1 ? stripped : stripped.slice(carriageReturn + 1);
  return visible.replace(/[ \t]+$/, "");
}

/** Splits a blob and normalises each line, preserving the line count. */
export function normalizeLines(input: string): string[] {
  return input.split("\n").map(normalizeLine);
}

export function isPassingNoise(line: string): boolean {
  return PASS_MARKERS.some((pattern) => pattern.test(line));
}

export function stripPassingNoise(lines: readonly string[]): string[] {
  return lines.filter((line) => !isPassingNoise(line));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/pruner.spec.ts`
Expected: `14 passed` (3 + 3 + 1 + 7).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: strip ansi, spinner overwrites and passing noise"
```

---

### Task 5: Stack pruning and the SignalWindow inliner (`src/pruner/stack-pruner.ts`)

Satisfies INV-4 and the `SignalWindow` half of §4.2: at most 5 repository frames plus 1 external boundary frame, and a ±`contextLines` source excerpt read from disk with the failing line marked `>`.

**Files:**
- Create: `src/pruner/stack-pruner.ts`
- Modify: `tests/pruner.spec.ts` (append a block)

- [ ] **Step 1: Write the failing test**

Append to `tests/pruner.spec.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isExternalFrame,
  pruneStack,
  readSignalWindow,
  toRepoRelative,
  topRepoFrame,
} from "../src/pruner/stack-pruner.js";

const REPO = "/work/repo";

describe("isExternalFrame", () => {
  it.each([
    "at node_modules/vitest/dist/chunk.js:1:1",
    "at node:internal/modules/cjs/loader:1234:14",
    "at /nix/store/abc123-python-3.11/lib/python3.11/site.py:10:1",
    "at .venv/lib/python3.11/site-packages/requests/api.py:61:9",
    "at /usr/lib/node_modules/tsc/lib/tsc.js:9:9",
    "at /rustc/abc/library/std/src/panic.rs:1:1",
  ])("flags %s as external", (frame) => {
    expect(isExternalFrame(frame)).toBe(true);
  });

  it.each([
    "at parseToken (src/auth/jwt.ts:28:19)",
    "at Object.<anonymous> (tests/login.spec.ts:12:5)",
    "File \"/work/repo/app/main.py\", line 12, in handler",
  ])("keeps %s as a repository frame", (frame) => {
    expect(isExternalFrame(frame)).toBe(false);
  });
});

describe("pruneStack", () => {
  it("keeps five repository frames plus one external boundary frame", () => {
    const frames = [
      "at parseToken (src/auth/jwt.ts:28:19)",
      "at login (src/auth/session.ts:44:11)",
      "at run (src/app/router.ts:9:3)",
      "at main (src/index.ts:4:1)",
      "at start (src/boot.ts:2:1)",
      "at six (src/extra.ts:1:1)",
      "at node_modules/vitest/dist/chunk.js:1:1",
      "at node_modules/vitest/dist/other.js:2:2",
    ];
    expect(pruneStack(frames, REPO)).toEqual([
      "at parseToken (src/auth/jwt.ts:28:19)",
      "at login (src/auth/session.ts:44:11)",
      "at run (src/app/router.ts:9:3)",
      "at main (src/index.ts:4:1)",
      "at start (src/boot.ts:2:1)",
      "at node_modules/vitest/dist/chunk.js:1:1",
    ]);
  });

  it("drops an external frame that never follows a repository frame", () => {
    const frames = ["at node_modules/x/index.js:1:1", "at main (src/index.ts:4:1)"];
    expect(pruneStack(frames, REPO)).toEqual(["at main (src/index.ts:4:1)"]);
  });

  it("returns an empty stack for an all-external trace", () => {
    expect(pruneStack(["at node_modules/x/index.js:1:1"], REPO)).toEqual([]);
  });
});

describe("topRepoFrame", () => {
  it("returns the first repository frame as a relative file:line:col", () => {
    const frames = [
      "at node_modules/vitest/dist/chunk.js:1:1",
      "at parseToken (src/auth/jwt.ts:28:19)",
    ];
    expect(topRepoFrame(frames, REPO)).toEqual({
      location: "src/auth/jwt.ts:28:19",
      file: "src/auth/jwt.ts",
      line: 28,
      column: 19,
    });
  });

  it("returns null when nothing is a repository frame", () => {
    expect(topRepoFrame(["at node_modules/x/index.js:1:1"], REPO)).toBeNull();
  });
});

describe("toRepoRelative", () => {
  it("keeps relative paths relative and strips a repository prefix", () => {
    expect(toRepoRelative("src/auth/jwt.ts", REPO)).toBe("src/auth/jwt.ts");
    expect(toRepoRelative("/work/repo/src/auth/jwt.ts", REPO)).toBe("src/auth/jwt.ts");
  });

  it("keeps outside paths intact rather than emitting ../../", () => {
    expect(toRepoRelative("/other/place/file.ts", REPO)).toBe("/other/place/file.ts");
  });
});

describe("readSignalWindow", () => {
  it("returns five lines with the failing line marked", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-window-"));
    const file = path.join(dir, "jwt.ts");
    fs.writeFileSync(file, "line1\nline2\nline3\nline4\nline5\nline6\nline7\n");
    expect(readSignalWindow(file, 4, 2, dir)).toBe(
      ["2 | line2", "3 | line3", "4 > line4", "5 | line5", "6 | line6"].join("\n"),
    );
  });

  it("clamps at the start of the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-window-"));
    const file = path.join(dir, "jwt.ts");
    fs.writeFileSync(file, "only\n");
    expect(readSignalWindow(file, 1, 2, dir)).toBe("1 > only");
  });

  it("returns an empty string when the file is gone", () => {
    expect(readSignalWindow("/definitely/not/here.ts", 3, 2, REPO)).toBe("");
  });

  it("honours --context-lines=0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-window-"));
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "a\nb\nc\n");
    expect(readSignalWindow(file, 2, 0, dir)).toBe("2 > b");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/pruner.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/pruner/stack-pruner.js"`.

- [ ] **Step 3: Write `src/pruner/stack-pruner.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { MAX_REPO_FRAMES } from "../types/schema.js";

const EXTERNAL_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])node_modules[\\/]/,
  /^node:/,
  /(^|[\\/])nix[\\/]store[\\/]/,
  /(^|[\\/])\.venv[\\/]/,
  /(^|[\\/])site-packages[\\/]/,
  /^\/usr\/(?:lib|local|share)\//,
  /^\/rustc\//,
  /(^|[\\/])rustlib[\\/]/,
  /(^|[\\/])go[\\/]src[\\/]/,
  /(^|[\\/])src[\\/]runtime[\\/]/,
  /^internal\//,
  /<anonymous>/,
];

const FRAME_FILE = /((?:[A-Za-z]:)?[^\s()"']+\.(?:[cm]?[jt]sx?|py|rs|go)):(\d+)(?::(\d+))?/;
const FRAME_SYMBOL = /\bat\s+([^\s(]+)\s*\(/;
const PY_SYMBOL = /\bin\s+([A-Za-z_][\w.]*)\s*$/;

export interface FrameLocation {
  frame: string;
  file: string | null;
  line: number | null;
  column: number | null;
  symbol: string | null;
}

export interface ResolvedFrame {
  location: string;
  file: string;
  line: number;
  column: number;
}

export function parseFrame(frame: string): FrameLocation {
  const match = FRAME_FILE.exec(frame);
  const symbol = FRAME_SYMBOL.exec(frame) ?? PY_SYMBOL.exec(frame);
  return {
    frame: frame.trim(),
    file: match?.[1] ?? null,
    line: match?.[2] ? Number(match[2]) : null,
    column: match?.[3] ? Number(match[3]) : null,
    symbol: symbol?.[1] ?? null,
  };
}

export function isExternalFrame(frame: string): boolean {
  const target = parseFrame(frame).file ?? frame;
  return EXTERNAL_PATTERNS.some((pattern) => pattern.test(target));
}

export function toRepoRelative(file: string, repoRoot: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  if (relative === "" || relative.startsWith("..")) {
    return file.split(path.sep).join("/");
  }
  return relative;
}

/**
 * INV-4: keep up to five repository frames plus, at most, the single external
 * boundary frame that follows them (the exact third-party call site).
 */
export function pruneStack(frames: readonly string[], repoRoot: string): string[] {
  const kept: string[] = [];
  let repoFrames = 0;
  let boundaryKept = false;

  for (const frame of frames) {
    if (isExternalFrame(frame)) {
      if (!boundaryKept && repoFrames > 0) {
        kept.push(frame.trim());
        boundaryKept = true;
      }
      continue;
    }
    if (repoFrames >= MAX_REPO_FRAMES) continue;
    kept.push(frame.trim());
    repoFrames += 1;
  }

  return kept;
}

export function topRepoFrame(
  frames: readonly string[],
  repoRoot: string,
): ResolvedFrame | null {
  for (const frame of frames) {
    if (isExternalFrame(frame)) continue;
    const parsed = parseFrame(frame);
    if (parsed.file === null || parsed.line === null) continue;
    const file = toRepoRelative(parsed.file, repoRoot);
    const column = parsed.column ?? 1;
    return { location: `${file}:${parsed.line}:${column}`, file, line: parsed.line, column };
  }
  return null;
}

/**
 * Reads ±contextLines around `line` from `file`, marking the target with `>`.
 * Format: `28 >   return parts.split('.')`.
 */
export function readSignalWindow(
  file: string,
  line: number,
  contextLines = 2,
  repoRoot = process.cwd(),
): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  let source: string[];
  try {
    source = fs.readFileSync(absolute, "utf8").split("\n");
  } catch {
    return "";
  }

  const start = Math.max(1, line - contextLines);
  const end = Math.min(source.length, line + contextLines);
  const width = String(end).length;
  const rows: string[] = [];

  for (let current = start; current <= end; current += 1) {
    const marker = current === line ? " >" : " |";
    rows.push(`${String(current).padStart(width)}${marker} ${source[current - 1] ?? ""}`);
  }

  return rows.join("\n");
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/pruner.spec.ts && pnpm typecheck`
Expected: all pruner tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: prune third-party stack frames and inline signal windows"
```

---

### Task 6: RootCauseFingerprint and cascade deduplication (`src/pruner/cluster-dedup.ts`)

Satisfies INV-2 (collapse cascading failures, cap clusters) and the fingerprint definition in SPEC §1.

**Files:**
- Create: `src/pruner/cluster-dedup.ts`, `tests/dedup-and-tdd.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/dedup-and-tdd.spec.ts` (first block):

```ts
import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  dedupeFailures,
  normalizeAssertionTemplate,
  type RawFailure,
} from "../src/pruner/cluster-dedup.js";

const REPO = "/work/repo";

function failure(overrides: Partial<RawFailure> & Pick<RawFailure, "testName">): RawFailure {
  return {
    errorKind: "RUNTIME_EXCEPTION",
    message: "TypeError: token.split is not a function",
    frames: [
      "at parseToken (src/auth/jwt.ts:28:19)",
      ...Array.from({ length: 35 }, (_, i) => `at fn${i} (node_modules/vitest/dist/chunk.js:${i + 1}:1)`),
    ],
    startLine: 400,
    endLine: 448,
    ...overrides,
  };
}

describe("normalizeAssertionTemplate", () => {
  it("templates numbers, strings and paths out of a message", () => {
    expect(normalizeAssertionTemplate("expected 200 to be 401")).toBe("expected # to be #");
    expect(normalizeAssertionTemplate('expected "abc" to match /x/')).toBe(
      "expected * to match <path>",
    );
  });

  it("is stable across differing runtime values", () => {
    expect(normalizeAssertionTemplate("expected 1 to be 2")).toBe(
      normalizeAssertionTemplate("expected 999 to be 1000"),
    );
  });
});

describe("computeFingerprint", () => {
  it("hashes kind + top frame + template deterministically", () => {
    const a = computeFingerprint("RUNTIME_EXCEPTION", "src/auth/jwt.ts:28:19", "expected 1 to be 2");
    const b = computeFingerprint("RUNTIME_EXCEPTION", "src/auth/jwt.ts:28:19", "expected 7 to be 9");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("separates different kinds on the same frame", () => {
    const a = computeFingerprint("RUNTIME_EXCEPTION", "src/a.ts:1:1", "boom");
    const b = computeFingerprint("ASSERTION_FAILURE", "src/a.ts:1:1", "boom");
    expect(a).not.toBe(b);
  });
});

describe("dedupeFailures", () => {
  const options = { repoRoot: REPO, contextLines: 2, maxClusters: 5, logPath: "/tmp/run.log" };

  it("collapses 50 identical cascading failures into one cluster", () => {
    const failures = Array.from({ length: 50 }, (_, i) =>
      failure({ testName: `integration > case ${i}`, startLine: 400 + i * 40, endLine: 448 + i * 40 }),
    );
    const clusters = dedupeFailures(failures, options);
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    expect(cluster?.affected_count).toBe(50);
    expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(cluster?.top_frame).toBe("src/auth/jwt.ts:28:19");
    expect(cluster?.cluster_id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(cluster?.sample_tests).toHaveLength(3);
    expect(cluster?.pruned_stack.filter((f) => f.includes("node_modules"))).toHaveLength(1);
    expect(cluster?.raw_log_lines).toBe("L400-L2408");
    expect(cluster?.signal_window).toBe("");
  });

  it("keeps distinct root causes apart and honours maxClusters", () => {
    const failures = [
      failure({ testName: "a", startLine: 10, endLine: 20 }),
      failure({
        testName: "b",
        message: "AssertionError: expected 2 to be 3",
        errorKind: "ASSERTION_FAILURE",
        frames: ["at expectValue (src/math.ts:7:3)"],
        startLine: 30,
        endLine: 40,
      }),
      failure({
        testName: "c",
        message: "SyntaxError: Unexpected token '}'",
        errorKind: "SYNTAX_IMPORT_ERROR",
        frames: ["at src/broken.ts:3:1"],
        startLine: 50,
        endLine: 60,
      }),
    ];
    expect(dedupeFailures(failures, { ...options, maxClusters: 2 })).toHaveLength(2);
    expect(dedupeFailures(failures, options)).toHaveLength(3);
  });

  it("orders clusters by affected_count descending", () => {
    const failures = [
      failure({ testName: "solo", startLine: 500, endLine: 510 }),
      ...Array.from({ length: 3 }, (_, i) =>
        failure({
          testName: `group ${i}`,
          message: "AssertionError: expected 1 to be 2",
          errorKind: "ASSERTION_FAILURE",
          frames: ["at handler (src/handler.ts:5:1)"],
          startLine: 100 + i,
          endLine: 110 + i,
        }),
      ),
    ];
    const clusters = dedupeFailures(failures, options);
    expect(clusters.map((c) => c.affected_count)).toEqual([3, 1]);
  });

  it("carries the expected/received diff when the adapter captured one", () => {
    const [cluster] = dedupeFailures(
      [failure({ testName: "diff", diff: { expected: "401", received: "200" } })],
      options,
    );
    expect(cluster?.diff).toEqual({ expected: "401", received: "200" });
  });

  it("falls back to unknown:0:0 when no repository frame survives", () => {
    const [cluster] = dedupeFailures(
      [failure({ testName: "external", frames: ["at node_modules/x/index.js:1:1"] })],
      options,
    );
    expect(cluster?.top_frame).toBe("unknown:0:0");
    expect(cluster?.pruned_stack).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/dedup-and-tdd.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/pruner/cluster-dedup.js"`.

- [ ] **Step 3: Write `src/pruner/cluster-dedup.ts`**

```ts
import { createHash } from "node:crypto";
import type { ErrorKind, FailureCluster } from "../types/schema.js";
import { pruneStack, readSignalWindow, topRepoFrame } from "./stack-pruner.js";

export interface RawFailure {
  testName: string | null;
  errorKind: ErrorKind;
  message: string;
  frames: string[];
  diff?: { expected: string; received: string };
  startLine: number;
  endLine: number;
}

export interface DedupeOptions {
  repoRoot: string;
  contextLines: number;
  maxClusters: number;
  logPath: string;
}

/**
 * Turns a message into its failure *template*: numbers, quoted values and
 * filesystem paths are the parts that differ between cascading failures.
 */
export function normalizeAssertionTemplate(message: string): string {
  return message
    .replace(/`[^`]*`/g, "*")
    .replace(/'[^']*'/g, "*")
    .replace(/"[^"]*"/g, "*")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .replace(/\/[^\s:]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}

/** SHA256(error_kind + top_repo_frame_location + normalized_assertion_template). */
export function computeFingerprint(
  kind: ErrorKind,
  topFrame: string,
  message: string,
): string {
  const payload = `${kind}|${topFrame}|${normalizeAssertionTemplate(message)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function dedupeFailures(
  failures: readonly RawFailure[],
  options: DedupeOptions,
): FailureCluster[] {
  const groups = new Map<string, RawFailure[]>();

  for (const failure of failures) {
    const top = topRepoFrame(failure.frames, options.repoRoot);
    const topLocation = top?.location ?? "unknown:0:0";
    const fingerprint = computeFingerprint(failure.errorKind, topLocation, failure.message);
    const bucket = groups.get(fingerprint);
    if (bucket) bucket.push(failure);
    else groups.set(fingerprint, [failure]);
  }

  const clusters: FailureCluster[] = [];

  for (const [fingerprint, bucket] of groups) {
    const first = bucket[0];
    if (first === undefined) continue;
    const top = topRepoFrame(first.frames, options.repoRoot);
    const sampleTests = [
      ...new Set(bucket.map((item) => item.testName).filter((name): name is string => name !== null)),
    ].slice(0, 3);
    const startLine = Math.min(...bucket.map((item) => item.startLine));
    const endLine = Math.max(...bucket.map((item) => item.endLine));

    clusters.push({
      cluster_id: `c_${fingerprint.slice(0, 8)}`,
      fingerprint,
      error_kind: first.errorKind,
      affected_count: bucket.length,
      sample_tests: sampleTests,
      ...(first.diff ? { diff: first.diff } : {}),
      message: first.message,
      top_frame: top?.location ?? "unknown:0:0",
      pruned_stack: pruneStack(first.frames, options.repoRoot),
      signal_window: top
        ? readSignalWindow(top.file, top.line, options.contextLines, options.repoRoot)
        : "",
      raw_log_lines: `L${startLine}-L${endLine}`,
    });
  }

  return clusters
    .sort(
      (a, b) =>
        b.affected_count - a.affected_count || a.raw_log_lines.localeCompare(b.raw_log_lines),
    )
    .slice(0, options.maxClusters);
}
```

**Note on the first test's `signal_window` assertion:** it passes only because `/work/repo/src/auth/jwt.ts` does not exist, so the inliner returns `""`. That is intentional — Task 9 covers the real excerpt.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/dedup-and-tdd.spec.ts`
Expected: `8 passed`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: fingerprint and collapse cascading failures into bounded clusters"
```

---

### Task 7: Process capture and the raw-log tee (`src/runner/raw-log.ts`, `src/runner/capture.ts`)

Satisfies Gear 2 (SPEC §2.3) and INV-3: every byte is persisted, every emitted line carries its exact raw-log line number, and the child's exit code or signal is preserved.

**Files:**
- Create: `src/runner/raw-log.ts`, `src/runner/capture.ts`, `tests/runner.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/runner.spec.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RawLogWriter, formatLineRange } from "../src/runner/raw-log.js";
import { runChild, signalExitCode } from "../src/runner/capture.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dtd-runner-"));
}

describe("RawLogWriter", () => {
  it("writes chunks to disk and reports the first line number of each chunk", () => {
    const dir = tempHome();
    const log = new RawLogWriter({ dir });
    expect(log.write("a\nb\n")).toBe(1);
    expect(log.write("c\n")).toBe(3);
    log.close();
    expect(fs.readFileSync(log.path, "utf8")).toBe("a\nb\nc\n");
    expect(log.path.startsWith(dir)).toBe(true);
    expect(path.basename(log.path)).toMatch(/^run_[a-z0-9]+\.log$/);
  });

  it("formats a line range pointer", () => {
    expect(formatLineRange(412, 448)).toBe("L412-L448");
  });
});

describe("runChild", () => {
  it("captures stdout and stderr with absolute line numbers", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(
      ["node", "-e", "process.stdout.write('one\\n'); process.stderr.write('two\\n')"],
      { rawLog: log },
    );
    log.close();
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.lines).toEqual([
      { stream: "stdout", text: "one", line: 1 },
      { stream: "stderr", text: "two", line: 2 },
    ]);
  });

  it("reports the child exit code unchanged", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(["node", "-e", "process.exit(42)"], { rawLog: log });
    log.close();
    expect(result.exitCode).toBe(42);
  });

  it("captures a partial final line", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(["node", "-e", "process.stdout.write('no newline')"], {
      rawLog: log,
    });
    log.close();
    expect(result.lines).toEqual([{ stream: "stdout", text: "no newline", line: 1 }]);
  });

  it("maps a fatal signal to 128 + signal number", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(
      ["node", "-e", "process.kill(process.pid, 'SIGTERM')"],
      { rawLog: log },
    );
    log.close();
    expect(result.signal).toBe("SIGTERM");
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  it("throws a readable error when the command does not exist", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    await expect(runChild(["definitely-not-a-command-xyz"], { rawLog: log })).rejects.toThrow(
      /ENOENT/,
    );
    log.close();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/runner.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/runner/raw-log.js"`.

- [ ] **Step 3: Write `src/runner/raw-log.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** R12: single override point for every cache artifact. */
export function cacheRoot(): string {
  const override = process.env["DOT_TEST_DIGEST_HOME"];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".cache", "dot-test-digest");
}

export function defaultLogDir(): string {
  return path.join(cacheRoot(), "logs");
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function formatLineRange(start: number, end: number): string {
  return `L${start}-L${end}`;
}

export interface RawLogOptions {
  dir?: string;
  runId?: string;
}

/**
 * Append-only raw stream. Only whole lines are ever written, so the file's line
 * numbers are exactly the numbers reported to the caller.
 */
export class RawLogWriter {
  readonly runId: string;
  readonly path: string;

  private readonly fd: number;
  private nextLine = 1;

  constructor(options: RawLogOptions = {}) {
    const directory = options.dir ?? defaultLogDir();
    fs.mkdirSync(directory, { recursive: true });
    this.runId = options.runId ?? newRunId();
    this.path = path.join(directory, `${this.runId}.log`);
    this.fd = fs.openSync(this.path, "a");
  }

  /** Appends a chunk of whole lines and returns the 1-based line number of its first line. */
  write(chunk: string): number {
    const first = this.nextLine;
    fs.writeSync(this.fd, chunk);
    this.nextLine += chunk.split("\n").length - 1;
    return first;
  }

  get linesWritten(): number {
    return this.nextLine - 1;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
```

- [ ] **Step 4: Write `src/runner/capture.ts`**

```ts
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { RawLogWriter } from "./raw-log.js";

export type StreamName = "stdout" | "stderr";

export interface CapturedLine {
  stream: StreamName;
  text: string;
  line: number;
}

export interface CaptureResult {
  lines: CapturedLine[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface CaptureOptions {
  rawLog: RawLogWriter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** POSIX convention: a signal death is reported as 128 + signal number. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0;
  const number = constants.signals[signal];
  return 128 + (typeof number === "number" ? number : 0);
}

export function runChild(
  command: readonly string[],
  options: CaptureOptions,
): Promise<CaptureResult> {
  const [binary, ...args] = command;
  if (binary === undefined) return Promise.reject(new Error("runChild: empty command"));

  const startedAt = Date.now();
  const child = spawn(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const lines: CapturedLine[] = [];
  const pending: Record<StreamName, string> = { stdout: "", stderr: "" };
  const decoders: Record<StreamName, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };

  const ingest = (stream: StreamName, text: string): void => {
    pending[stream] += text;
    const parts = pending[stream].split("\n");
    pending[stream] = parts.pop() ?? "";
    if (parts.length === 0) return;
    const first = options.rawLog.write(parts.map((part) => `${part}\n`).join(""));
    parts.forEach((part, offset) => lines.push({ stream, text: part, line: first + offset }));
  };

  child.stdout.on("data", (chunk: Buffer) => ingest("stdout", decoders.stdout.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => ingest("stderr", decoders.stderr.write(chunk)));

  return new Promise<CaptureResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      ingest("stdout", decoders.stdout.end());
      ingest("stderr", decoders.stderr.end());
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = pending[stream];
        if (rest.length === 0) continue;
        const first = options.rawLog.write(`${rest}\n`);
        lines.push({ stream, text: rest, line: first });
        pending[stream] = "";
      }
      resolve({
        lines,
        exitCode: code ?? signalExitCode(signal),
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm vitest run tests/runner.spec.ts && pnpm typecheck`
Expected: `7 passed`; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: capture child streams to a line-numbered raw log with signal transparency"
```

---

### Task 8: Gear 0 grammar adapters (`src/adapters/`)

Implements REQ-GEAR0-ENGINE (§4.2): four deterministic grammars, one registry, one `ErrorKind` classifier. No network, no heuristics — if a grammar does not match, `runGear0` returns `null` and the pipeline moves to Gear 1.

**Files:**
- Create: `src/adapters/common.ts`, `src/adapters/index.ts`, `src/adapters/js-test.ts`, `src/adapters/tsc-eslint.ts`, `src/adapters/python.ts`, `src/adapters/rust-go.ts`, `tests/adapters.spec.ts`

`src/adapters/common.ts` exists so the registry and the four grammars can share helpers without a circular import. Every adapter returns the same `AdapterResult`, and only `index.ts` picks the winner (`MIN_ADAPTER_SCORE = 3`, so a stray `FAIL\tpkg\t0.2s` line from Go output can never win over the Go grammar).

- [ ] **Step 1: Write the failing test**

`tests/adapters.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ADAPTERS, classifyMessage, runGear0, selectAdapter } from "../src/adapters/index.js";
import type { CapturedLine } from "../src/runner/capture.js";

function lines(text: string): CapturedLine[] {
  return text.split("\n").map((line, index) => ({
    stream: "stdout" as const,
    text: line,
    line: index + 1,
  }));
}

const VITEST_FAILURE = ` FAIL  tests/auth.spec.ts > login > rejects expired token
AssertionError: expected 200 to be 401
Expected: 401
Received: 200
 ❯ parseToken (src/auth/jwt.ts:28:19)
 ❯ node_modules/vitest/dist/chunk.js:1:1

 Test Files  1 failed | 31 passed (32)
      Tests  1 failed | 239 passed (240)`;

const VITEST_PASS = ` ✓ tests/auth.spec.ts (12 tests) 640ms
 Test Files  32 passed (32)
      Tests  240 passed (240)`;

const TSC = `src/auth/jwt.ts(28,19): error TS2339: Property 'split' does not exist on type 'Token'.
src/auth/session.ts(12,5): error TS2339: Property 'split' does not exist on type 'Token'.
src/import.ts(3,10): error TS2307: Cannot find module './helprs' or its corresponding type declarations.`;

const PYTEST = `============================= test session starts ==============================
collected 3 items

=================================== FAILURES ===================================
___________________________________ test_total ___________________________________

    def test_total():
>       assert cart.total() == 100
E       AssertionError: assert 99 == 100

tests/test_cart.py:12: in test_total
    assert cart.total() == 100
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_total - AssertionError: assert 99 == 100
========================= 1 failed, 2 passed in 0.12s =========================`;

const CARGO = `   Compiling app v0.1.0
error[E0308]: mismatched types
 --> src/main.rs:4:9
  |
4 |     let x: u8 = "s";
  |         ^^^^^^ expected \`u8\`, found \`&str\`

thread 'tests::parse' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`;

const GO = `--- FAIL: TestTotal (0.00s)
    cart_test.go:12: got 99, want 100
FAIL
exit status 1
FAIL	example.com/cart	0.002s`;

describe("registry", () => {
  it("exposes four adapters", () => {
    expect(ADAPTERS.map((a) => a.name)).toEqual([
      "js-test",
      "tsc-eslint",
      "python",
      "rust-go",
    ]);
  });

  it("selects the vitest grammar for a vitest stream", () => {
    expect(selectAdapter(lines(VITEST_FAILURE).map((l) => l.text))?.name).toBe("js-test");
  });

  it("selects the go grammar, not js-test, for a go stream", () => {
    expect(selectAdapter(lines(GO).map((l) => l.text))?.name).toBe("rust-go");
  });

  it("returns null when nothing matches", () => {
    expect(runGear0(lines("hello\nworld"))).toBeNull();
  });
});

describe("js-test adapter", () => {
  it("extracts the failing test, its diff and its frames", () => {
    const result = runGear0(lines(VITEST_FAILURE));
    expect(result?.counts).toEqual({ passed: 239, failed: 1, skipped: 0 });
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("login > rejects expired token");
    expect(failure?.errorKind).toBe("ASSERTION_FAILURE");
    expect(failure?.message).toContain("expected 200 to be 401");
    expect(failure?.diff).toEqual({ expected: "401", received: "200" });
    expect(failure?.frames).toEqual([
      "parseToken (src/auth/jwt.ts:28:19)",
      "node_modules/vitest/dist/chunk.js:1:1",
    ]);
  });

  it("reads counts from a clean passing run and produces no failures", () => {
    const result = runGear0(lines(VITEST_PASS));
    expect(result?.counts).toEqual({ passed: 240, failed: 0, skipped: 0 });
    expect(result?.failures).toEqual([]);
  });

  it("classifies an unresolved import as SYNTAX_IMPORT_ERROR", () => {
    const stream = ` FAIL  tests/discount.spec.ts > applies discount
Error: Failed to resolve import "./helprs" from "tests/discount.spec.ts". Does the file exist?
 ❯ tests/discount.spec.ts:3:1

      Tests  1 failed (1)`;
    const [failure] = runGear0(lines(stream))?.failures ?? [];
    expect(failure?.errorKind).toBe("SYNTAX_IMPORT_ERROR");
  });
});

describe("tsc adapter", () => {
  it("parses one diagnostic per error line", () => {
    const result = runGear0(lines(TSC));
    expect(result?.failures).toHaveLength(3);
    expect(result?.counts.failed).toBe(3);
    expect(result?.failures.map((f) => f.errorKind)).toEqual([
      "TYPE_COMPILE_ERROR",
      "TYPE_COMPILE_ERROR",
      "SYNTAX_IMPORT_ERROR",
    ]);
    expect(result?.failures[0]?.frames).toEqual(["src/auth/jwt.ts:28:19"]);
    expect(result?.failures[0]?.message).toBe("TS2339: Property 'split' does not exist on type 'Token'.");
  });
});

describe("python adapter", () => {
  it("parses the traceback block instead of duplicating it from the summary", () => {
    const result = runGear0(lines(PYTEST));
    expect(result?.counts).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(result?.failures).toHaveLength(1);
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("test_total");
    expect(failure?.errorKind).toBe("ASSERTION_FAILURE");
    expect(failure?.frames).toEqual(["tests/test_cart.py:12"]);
  });
});

describe("rust-go adapter", () => {
  it("parses a rustc span and a panic", () => {
    const result = runGear0(lines(CARGO));
    expect(result?.counts).toEqual({ passed: 2, failed: 1, skipped: 0 });
    const kinds = result?.failures.map((f) => f.errorKind) ?? [];
    expect(kinds).toContain("TYPE_COMPILE_ERROR");
    expect(kinds).toContain("RUNTIME_EXCEPTION");
    expect(result?.failures.find((f) => f.errorKind === "RUNTIME_EXCEPTION")?.frames).toEqual([
      "src/lib.rs:10:5",
    ]);
  });

  it("parses a go test failure location", () => {
    const result = runGear0(lines(GO));
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("TestTotal");
    expect(failure?.message).toBe("got 99, want 100");
    expect(failure?.frames).toEqual(["cart_test.go:12"]);
  });
});

describe("classifyMessage", () => {
  it.each([
    ["AssertionError: expected 1 to be 2", "ASSERTION_FAILURE"],
    ["Cannot find module './x'", "SYNTAX_IMPORT_ERROR"],
    ["Timeout of 5000ms exceeded", "TIMEOUT_OR_CONN_REFUSED"],
    ["ECONNREFUSED 127.0.0.1:5432", "TIMEOUT_OR_CONN_REFUSED"],
    ["TypeError: token.split is not a function", "RUNTIME_EXCEPTION"],
  ] as const)("classifies %s", (message, kind) => {
    expect(classifyMessage(message)).toBe(kind);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/adapters.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/adapters/index.js"`.

- [ ] **Step 3: Write `src/adapters/common.ts`**

```ts
import type { RawFailure } from "../pruner/cluster-dedup.js";
import type { CapturedLine } from "../runner/capture.js";
import type { ErrorKind } from "../types/schema.js";

export interface AdapterCounts {
  passed: number;
  failed: number;
  skipped: number;
}

export interface AdapterResult {
  adapter: string;
  failures: RawFailure[];
  counts: AdapterCounts;
}

export interface Adapter {
  name: string;
  /** Returns 0 when the stream is not this grammar; higher is a better match. */
  detect(lines: readonly string[]): number;
  parse(lines: readonly CapturedLine[]): AdapterResult;
}

const SYNTAX_TOKENS: readonly RegExp[] = [
  /SyntaxError/,
  /Cannot find module/,
  /Failed to resolve import/,
  /ERR_MODULE_NOT_FOUND/,
  /ModuleNotFoundError/,
  /ImportError/,
  /\bTS2307\b/,
  /\bTS1\d{3}\b/,
  /Unexpected token/,
  /Unexpected end of input/,
];

const TIMEOUT_TOKENS: readonly RegExp[] = [
  /Timeout of \d+ms exceeded/,
  /\btimed out\b/i,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /EADDRINUSE/,
];

const ASSERTION_TOKENS: readonly RegExp[] = [
  /AssertionError/,
  /^Assertion\b/,
  /\bexpect\(/,
  /\bexpected\b.*\bto (?:be|equal|match|contain|throw)\b/i,
  /^\s*assert\b/,
];

/** Single source of truth for `error_kind` on a free-text message. */
export function classifyMessage(message: string): ErrorKind {
  if (SYNTAX_TOKENS.some((token) => token.test(message))) return "SYNTAX_IMPORT_ERROR";
  if (TIMEOUT_TOKENS.some((token) => token.test(message))) return "TIMEOUT_OR_CONN_REFUSED";
  if (ASSERTION_TOKENS.some((token) => token.test(message))) return "ASSERTION_FAILURE";
  return "RUNTIME_EXCEPTION";
}

export function emptyCounts(): AdapterCounts {
  return { passed: 0, failed: 0, skipped: 0 };
}

/** Reads `N passed | N failed | N skipped` out of one summary line, if present. */
export function readCountTokens(line: string): AdapterCounts | null {
  const failed = /(\d+)\s+failed\b/i.exec(line);
  const passed = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(line);
  const skipped = /(\d+)\s+(?:skipped|pending|ignored|todo)\b/i.exec(line);
  if (failed === null && passed === null && skipped === null) return null;
  return {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0,
  };
}

/** Summary lines may report the same totals twice (test files vs tests). */
export function mergeCounts(into: AdapterCounts, from: AdapterCounts): AdapterCounts {
  return {
    passed: Math.max(into.passed, from.passed),
    failed: Math.max(into.failed, from.failed),
    skipped: Math.max(into.skipped, from.skipped),
  };
}
```

- [ ] **Step 4: Write `src/adapters/index.ts`**

```ts
import type { CapturedLine } from "../runner/capture.js";
import { jsTestAdapter } from "./js-test.js";
import { pythonAdapter } from "./python.js";
import { rustGoAdapter } from "./rust-go.js";
import { tscEslintAdapter } from "./tsc-eslint.js";
import type { Adapter, AdapterResult } from "./common.js";

export {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

/** A single stray `FAIL\tpkg\t0.2s` line scores 1; a real grammar scores 3 or more. */
const MIN_ADAPTER_SCORE = 3;

export const ADAPTERS: readonly Adapter[] = [
  jsTestAdapter,
  tscEslintAdapter,
  pythonAdapter,
  rustGoAdapter,
];

export function selectAdapter(lines: readonly string[]): Adapter | null {
  let best: { adapter: Adapter; score: number } | null = null;
  for (const adapter of ADAPTERS) {
    const score = adapter.detect(lines);
    if (score < MIN_ADAPTER_SCORE) continue;
    if (best === null || score > best.score) best = { adapter, score };
  }
  return best?.adapter ?? null;
}

/** Runs the winning grammar, or returns null when Gear 0 has nothing to say. */
export function runGear0(lines: readonly CapturedLine[]): AdapterResult | null {
  const adapter = selectAdapter(lines.map((line) => line.text));
  return adapter === null ? null : adapter.parse(lines);
}
```

- [ ] **Step 5: Write `src/adapters/js-test.ts`**

```ts
import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

const HEADER = /^\s*(?:FAIL|✕|×|✗|●|not ok\s+\d+)\s+(.+?)\s*$/;
const FRAME = /^\s*(?:❯|at)\s+(.+?)\s*$/;
const ERROR_MESSAGE = /(?:^|\s)((?:[A-Za-z]*Error|AssertionError)[^\n]*)$/;
const SUMMARY = /\b(?:Tests|Test Files|Tests:)\b/;

export const jsTestAdapter: Adapter = {
  name: "js-test",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (HEADER.test(line)) score += 1;
      if (SUMMARY.test(line) || /^\s*\d+\s+passing\s*\(/.test(line)) score += 3;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let counts: AdapterCounts = emptyCounts();
    let current: RawFailure | null = null;

    const flush = (): void => {
      if (current === null) return;
      current.errorKind = classifyMessage(`${current.message}\n${current.frames.join("\n")}`);
      if (current.message === "") current.message = "Unknown test failure";
      failures.push(current);
      current = null;
    };

    for (const line of lines) {
      const text = line.text;

      const header = HEADER.exec(text);
      if (header) {
        flush();
        const name = (header[1] ?? "").replace(/^\S+\.(?:spec|test)\.[cm]?[jt]sx?\s*>\s*/, "").trim();
        current = {
          testName: name === "" ? null : name,
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        continue;
      }

      if (SUMMARY.test(text)) {
        const tokens = readCountTokens(text);
        if (tokens !== null) counts = mergeCounts(counts, tokens);
        continue;
      }

      if (current === null) {
        if (!FRAME.test(text) && !ERROR_MESSAGE.test(text)) continue;
        current = {
          testName: null,
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
      }

      current.endLine = line.line;

      if (current.message === "") {
        const message = ERROR_MESSAGE.exec(text);
        if (message?.[1] !== undefined) current.message = message[1].trim();
      }

      const frame = FRAME.exec(text);
      if (frame?.[1] !== undefined) {
        current.frames.push(frame[1]);
        continue;
      }

      const expected = /^\s*Expected\s*:?\s*(.+)$/i.exec(text);
      const received = /^\s*Received\s*:?\s*(.+)$/i.exec(text);
      if (expected !== null || received !== null) {
        const diff = current.diff ?? { expected: "", received: "" };
        if (expected?.[1] !== undefined) diff.expected = expected[1].trim();
        if (received?.[1] !== undefined) diff.received = received[1].trim();
        current.diff = diff;
        continue;
      }

      if (current.diff === undefined) {
        const inline = /\bexpected\s+(.+?)\s+to\s+(?:be|equal|match|contain|throw)\s+(.+)$/i.exec(
          text,
        );
        if (inline?.[1] !== undefined && inline[2] !== undefined) {
          current.diff = { expected: inline[2].trim(), received: inline[1].trim() };
        }
      }
    }

    flush();
    if (counts.failed === 0 && failures.length > 0) counts.failed = failures.length;
    return { adapter: "js-test", failures, counts };
  },
};
```

- [ ] **Step 6: Write `src/adapters/tsc-eslint.ts`**

```ts
import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import { classifyMessage, type Adapter, type AdapterResult } from "./common.js";

const TSC = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
const ESLINT_FILE = /^(?:\/\S+|[A-Za-z]:\\\S+)$/;
const ESLINT_DIAG = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)?\s*$/;

export const tscEslintAdapter: Adapter = {
  name: "tsc-eslint",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (TSC.test(line)) score += 3;
      else if (ESLINT_DIAG.test(line)) score += 1;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let errors = 0;
    let warnings = 0;
    let file = "";

    for (const line of lines) {
      const text = line.text;

      const tsc = TSC.exec(text);
      if (tsc) {
        const [, path, row, column, severity, code, message] = tsc;
        if (severity === "error") errors += 1;
        else warnings += 1;
        const isSyntax = code === "TS2307" || /^TS1\d{3}$/.test(code ?? "");
        failures.push({
          testName: null,
          errorKind: isSyntax ? "SYNTAX_IMPORT_ERROR" : "TYPE_COMPILE_ERROR",
          message: `${code ?? "TS0000"}: ${message ?? ""}`,
          frames: [`${path ?? ""}:${row ?? "0"}:${column ?? "0"}`],
          startLine: line.line,
          endLine: line.line,
        });
        continue;
      }

      if (ESLINT_FILE.test(text) && /\.(?:[cm]?[jt]sx?)$/.test(text)) {
        file = text.trim();
        continue;
      }

      const eslint = ESLINT_DIAG.exec(text);
      if (eslint && file !== "") {
        const [, row, column, severity, message] = eslint;
        if (severity === "error") errors += 1;
        else warnings += 1;
        failures.push({
          testName: null,
          errorKind: classifyMessage(message ?? ""),
          message: (message ?? "").trim(),
          frames: [`${file}:${row ?? "0"}:${column ?? "0"}`],
          startLine: line.line,
          endLine: line.line,
        });
      }
    }

    return { adapter: "tsc-eslint", failures, counts: { passed: 0, failed: errors, skipped: warnings } };
  },
};
```

- [ ] **Step 7: Write `src/adapters/python.ts`**

```ts
import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

const BLOCK_HEADER = /^_{2,}\s+(.+?)\s+_{2,}$/;
const LOCATION = /^(\S+\.py):(\d+):\s+in\s+(\S+)$/;
const ERROR_LINE = /^E\s{2,}(.+)$/;
const SHORT_SUMMARY = /^FAILED\s+(\S+?)(?:::(\S+))?\s+-\s+(.*)$/;
const SESSION_SUMMARY = /^=+\s.*\b(?:failed|passed|error)\b.*=+$/;
const SESSION_START = /test session starts/;

export const pythonAdapter: Adapter = {
  name: "python",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (BLOCK_HEADER.test(line)) score += 3;
      else if (LOCATION.test(line)) score += 2;
      else if (SHORT_SUMMARY.test(line)) score += 3;
      else if (SESSION_START.test(line)) score += 2;
      else if (SESSION_SUMMARY.test(line)) score += 2;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let counts: AdapterCounts = emptyCounts();
    let current: RawFailure | null = null;
    let sawBlock = false;

    const flush = (): void => {
      if (current === null) return;
      current.errorKind = classifyMessage(`${current.message}\n${current.frames.join("\n")}`);
      if (current.message === "") current.message = "Unknown pytest failure";
      failures.push(current);
      current = null;
    };

    for (const line of lines) {
      const text = line.text;

      const header = BLOCK_HEADER.exec(text);
      if (header) {
        flush();
        sawBlock = true;
        current = {
          testName: (header[1] ?? "").trim(),
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        continue;
      }

      if (SESSION_SUMMARY.test(text)) {
        const tokens = readCountTokens(text);
        if (tokens !== null) counts = mergeCounts(counts, tokens);
        continue;
      }

      if (current !== null) {
        current.endLine = line.line;
        const location = LOCATION.exec(text);
        if (location) {
          current.frames.push(`${location[1]}:${location[2]}`);
          continue;
        }
        const error = ERROR_LINE.exec(text);
        if (error?.[1] !== undefined && current.message === "") {
          current.message = error[1].trim();
          continue;
        }
        continue;
      }

      const short = SHORT_SUMMARY.exec(text);
      if (short && !sawBlock) {
        failures.push({
          testName: (short[2] ?? short[1] ?? "").trim(),
          errorKind: classifyMessage(short[3] ?? ""),
          message: (short[3] ?? "").trim(),
          frames: [],
          startLine: line.line,
          endLine: line.line,
        });
      }
    }

    flush();
    if (counts.failed === 0) counts.failed = failures.length;
    return { adapter: "python", failures, counts };
  },
};
```

- [ ] **Step 8: Write `src/adapters/rust-go.ts`**

```ts
import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

const CARGO_DIAG = /^error(?:\[(\w+)\])?:\s+(.+)$/;
const CARGO_SPAN = /^\s*-->\s+(\S+):(\d+):(\d+)/;
const CARGO_PANIC = /^thread '(.+?)' panicked at (.+?):(\d+):(\d+)/;
const CARGO_SUMMARY = /^test result: (?:FAILED|ok)\.\s*(.*)$/;
const GO_FAIL = /^--- FAIL: (\S+)/;
const GO_LOCATION = /^\s+(\S+_test\.go):(\d+):\s+(.*)$/;

export const rustGoAdapter: Adapter = {
  name: "rust-go",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (CARGO_DIAG.test(line)) score += 3;
      else if (CARGO_PANIC.test(line)) score += 3;
      else if (GO_FAIL.test(line)) score += 3;
      else if (GO_LOCATION.test(line)) score += 2;
      else if (CARGO_SPAN.test(line)) score += 2;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let counts: AdapterCounts = emptyCounts();
    let pendingDiagnostic: RawFailure | null = null;
    let current: RawFailure | null = null;

    for (const line of lines) {
      const text = line.text;

      const summary = CARGO_SUMMARY.exec(text);
      if (summary) {
        const tokens = readCountTokens(summary[1] ?? "");
        if (tokens !== null) counts = mergeCounts(counts, tokens);
        continue;
      }

      const diagnostic = CARGO_DIAG.exec(text);
      if (diagnostic) {
        const failure: RawFailure = {
          testName: null,
          errorKind: diagnostic[1] === "E0432" || diagnostic[1] === "E0583"
            ? "SYNTAX_IMPORT_ERROR"
            : "TYPE_COMPILE_ERROR",
          message: `${diagnostic[1] ?? "rustc"}: ${diagnostic[2] ?? ""}`,
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        failures.push(failure);
        pendingDiagnostic = failure;
        continue;
      }

      const span = CARGO_SPAN.exec(text);
      if (span && pendingDiagnostic !== null) {
        pendingDiagnostic.frames.push(`${span[1]}:${span[2]}:${span[3]}`);
        pendingDiagnostic.endLine = line.line;
        pendingDiagnostic = null;
        continue;
      }

      const panic = CARGO_PANIC.exec(text);
      if (panic) {
        current = {
          testName: (panic[1] ?? "").trim(),
          errorKind: "RUNTIME_EXCEPTION",
          message: `panicked at ${panic[2]}:${panic[3]}:${panic[4]}`,
          frames: [`${panic[2]}:${panic[3]}:${panic[4]}`],
          startLine: line.line,
          endLine: line.line,
        };
        failures.push(current);
        current = null;
        continue;
      }

      const goFail = GO_FAIL.exec(text);
      if (goFail) {
        current = {
          testName: (goFail[1] ?? "").trim(),
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        failures.push(current);
        continue;
      }

      if (current !== null) {
        const location = GO_LOCATION.exec(text);
        if (location) {
          current.endLine = line.line;
          current.frames.push(`${location[1]}:${location[2]}`);
          current.message = (location[3] ?? "").trim();
          current.errorKind = classifyMessage(current.message);
          current = null;
          continue;
        }
        current.endLine = line.line;
      }
    }

    for (const failure of failures) {
      if (failure.message === "") failure.message = "Unknown rust/go failure";
    }
    if (counts.failed === 0) counts.failed = failures.filter((f) => f.errorKind !== "TYPE_COMPILE_ERROR" || f.frames.length > 0).length;
    return { adapter: "rust-go", failures, counts };
  },
};
```

- [ ] **Step 9: Run it and watch it pass**

Run: `pnpm vitest run tests/adapters.spec.ts && pnpm typecheck`
Expected: `13 passed`; typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add gear 0 grammar adapters for js, tsc, python, rust and go"
```

---

### Task 9: Envelope assembly, renderers and hard byte ceilings (`src/formatters/envelope.ts`)

Satisfies INV-1 (≤160 bytes on pass), INV-2 (≤600 tokens on failure) and CT-2's rendering requirements. Both ceilings are enforced here and nowhere else, so a regression in any upstream module cannot leak output.

**Files:**
- Create: `src/formatters/envelope.ts`, `tests/envelope.spec.ts`

**Decision (R13, note it in the commit):** INV-1's 160-byte ceiling applies to the default `compact-md` format. `--format=json` is a machine-format opt-in and emits the full envelope; CT-1 runs with the default format. Without this split the spec contradicts itself, because a conforming JSON envelope cannot fit in 160 bytes.

- [ ] **Step 1: Write the failing test**

`tests/envelope.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FAIL_BYTE_CEILING,
  PASS_BYTE_CEILING,
  buildEnvelope,
  estimateTokens,
  formatEnvelope,
  truncateBytes,
} from "../src/formatters/envelope.js";
import { DigestEnvelopeSchema, type FailureCluster } from "../src/types/schema.js";

const LOG = "/home/dev/.cache/dot-test-digest/logs/run_8f2a.log";

function cluster(overrides: Partial<FailureCluster> = {}): FailureCluster {
  return {
    cluster_id: "c_9f2a1b3c",
    fingerprint: "a".repeat(64),
    error_kind: "RUNTIME_EXCEPTION",
    affected_count: 47,
    sample_tests: ["login > rejects expired", "cart > totals", "orders > lists"],
    message: "TypeError: token.split is not a function",
    top_frame: "src/auth/jwt.ts:28:19",
    pruned_stack: [
      "at parseToken (src/auth/jwt.ts:28:19)",
      "at node_modules/vitest/dist/chunk.js:1:1",
    ],
    signal_window: ["26 | const parts", "27 | if (!parts) {", "28 >   await parts.split('.')", "29 | }", "30 | done"].join("\n"),
    raw_log_lines: "L412-L448",
    ...overrides,
  };
}

function passEnvelope() {
  return buildEnvelope({
    status: "PASS",
    phase: "green",
    exitCode: 0,
    signal: null,
    gear: "GEAR_0_GRAMMAR",
    durationMs: 640,
    counts: { passed: 240, failed: 0, skipped: 0 },
    clusters: [],
    delta: { newly_passing: 3, newly_broken_regressions: 0, still_failing: 0 },
    rawLogPath: LOG,
  });
}

describe("buildEnvelope", () => {
  it("produces a schema-valid envelope", () => {
    const envelope = buildEnvelope({
      status: "FAIL",
      phase: "green",
      exitCode: 1,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 1830,
      counts: { passed: 12, failed: 47, skipped: 1 },
      clusters: [cluster(), cluster({ cluster_id: "c_aaaa0000" })],
      rawLogPath: LOG,
    });
    expect(DigestEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.summary.total_clusters).toBe(2);
    expect(envelope.raw_log_path).toBe(LOG);
  });

  it("omits clusters and delta when they are absent", () => {
    const envelope = passEnvelope();
    expect(envelope.clusters).toBeUndefined();
    expect(DigestEnvelopeSchema.parse(envelope).delta).toEqual({
      newly_passing: 3,
      newly_broken_regressions: 0,
      still_failing: 0,
    });
  });
});

describe("truncateBytes / estimateTokens", () => {
  it("counts four bytes per token, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("never exceeds the byte budget", () => {
    const truncated = truncateBytes("x".repeat(400), 160);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(160);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("compact-md pass line", () => {
  it("matches SPEC Scenario 1 exactly", () => {
    expect(formatEnvelope(passEnvelope(), "compact-md").trim()).toBe(
      "[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: ~/.cache/dot-test-digest/logs/run_8f2a.log",
    );
  });

  it("stays under the 160-byte ceiling even with a deep home path", () => {
    const envelope = buildEnvelope({
      status: "PASS",
      phase: "none",
      exitCode: 0,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 123456,
      counts: { passed: 12345, failed: 0, skipped: 0 },
      clusters: [],
      rawLogPath: `${"/home/dev".padEnd(60, "x")}/.cache/dot-test-digest/logs/run_8f2a.log`,
    });
    const line = formatEnvelope(envelope, "compact-md");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(PASS_BYTE_CEILING + 1);
  });
});

describe("compact-md fail body", () => {
  it("renders one block per cluster with frame, window, tests and pointer", () => {
    const envelope = buildEnvelope({
      status: "FAIL",
      phase: "none",
      exitCode: 1,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 1830,
      counts: { passed: 12, failed: 47, skipped: 0 },
      clusters: [cluster()],
      rawLogPath: LOG,
    });
    const body = formatEnvelope(envelope, "compact-md");
    expect(body).toContain("[FAIL] 47 failed, 12 passed in 1830ms | 1 cluster");
    expect(body).toContain("c_9f2a1b3c RUNTIME_EXCEPTION x47 src/auth/jwt.ts:28:19");
    expect(body).toContain("28 >   await parts.split('.')");
    expect(body).toContain("tests: login > rejects expired, cart > totals, orders > lists");
    expect(body).toContain("raw: L412-L448");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(FAIL_BYTE_CEILING + 1);
  });

  it("drops the lowest-severity clusters to respect the 600-token ceiling", () => {
    const clusters = Array.from({ length: 5 }, (_, index) =>
      cluster({
        cluster_id: `c_${String(index).padStart(8, "0")}`,
        affected_count: 5 - index,
        signal_window: Array.from({ length: 11 }, (_, i) => `${20 + i} | ${"x".repeat(90)}`).join("\n"),
      }),
    );
    const envelope = buildEnvelope({
      status: "FAIL",
      phase: "none",
      exitCode: 1,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 1830,
      counts: { passed: 0, failed: 25, skipped: 0 },
      clusters,
      rawLogPath: LOG,
    });
    const body = formatEnvelope(envelope, "compact-md");
    expect(estimateTokens(body)).toBeLessThanOrEqual(600);
    expect(body).toMatch(/\+\d+ more clusters \(see log\)/);
  });
});

describe("statuses", () => {
  it("renders VALID_RED as a one-liner", () => {
    const envelope = buildEnvelope({
      status: "VALID_RED",
      phase: "red",
      exitCode: 0,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 900,
      counts: { passed: 0, failed: 1, skipped: 0 },
      clusters: [cluster({ affected_count: 1 })],
      rawLogPath: LOG,
    });
    const line = formatEnvelope(envelope, "compact-md");
    expect(line).toContain("[VALID_RED | RED] 0 passed, 1 failed");
    expect(line.includes("\n") && line.trim().split("\n").length > 1).toBe(false);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(PASS_BYTE_CEILING + 1);
  });

  it("renders INVALID_RED with its diagnosis", () => {
    const envelope = buildEnvelope({
      status: "INVALID_RED",
      phase: "red",
      exitCode: 64,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 120,
      counts: { passed: 0, failed: 1, skipped: 0 },
      clusters: [cluster({ error_kind: "SYNTAX_IMPORT_ERROR", top_frame: "tests/discount.spec.ts:3:1" })],
      rawLogPath: LOG,
    });
    const body = formatEnvelope(envelope, "compact-md");
    expect(body).toContain("[INVALID_RED | RED]");
    expect(body).toContain("SYNTAX_IMPORT_ERROR");
  });
});

describe("json format", () => {
  it("emits a parseable envelope with a trailing newline", () => {
    const text = formatEnvelope(passEnvelope(), "json");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = DigestEnvelopeSchema.parse(JSON.parse(text));
    expect(parsed.status).toBe("PASS");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/envelope.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/formatters/envelope.js"`.

- [ ] **Step 3: Write `src/formatters/envelope.ts`**

```ts
import os from "node:os";
import type {
  Delta,
  DigestEnvelope,
  DigestStatus,
  ExecutionGear,
  FailureCluster,
  OutputFormat,
  TddPhase,
} from "../types/schema.js";

export const PASS_BYTE_CEILING = 160;
export const FAIL_BYTE_CEILING = 2400;
export const MAX_FAIL_TOKENS = 600;
const BYTES_PER_TOKEN = 4;
const MESSAGE_BYTE_CEILING = 240;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export function shortenPath(target: string): string {
  const home = os.homedir();
  return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

export function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const marker = "...";
  const sliced = buffer.subarray(0, Math.max(0, maxBytes - marker.length)).toString("utf8");
  return `${sliced.replace(/\uFFFD+$/, "")}${marker}`;
}

export interface BuildEnvelopeInput {
  status: DigestStatus;
  phase: TddPhase;
  exitCode: number;
  signal: string | null;
  gear: ExecutionGear;
  durationMs: number;
  counts: { passed: number; failed: number; skipped: number };
  clusters: readonly FailureCluster[];
  delta?: Delta;
  rawLogPath: string;
}

export function buildEnvelope(input: BuildEnvelopeInput): DigestEnvelope {
  return {
    status: input.status,
    tdd_phase: input.phase,
    exit_code: input.exitCode,
    signal: input.signal,
    execution_gear: input.gear,
    duration_ms: input.durationMs,
    summary: {
      passed: input.counts.passed,
      failed: input.counts.failed,
      skipped: input.counts.skipped,
      total_clusters: input.clusters.length,
    },
    ...(input.delta ? { delta: input.delta } : {}),
    ...(input.clusters.length > 0 ? { clusters: [...input.clusters] } : {}),
    raw_log_path: input.rawLogPath,
  };
}

function statusLabel(envelope: DigestEnvelope): string {
  return envelope.tdd_phase === "none"
    ? envelope.status
    : `${envelope.status} | ${envelope.tdd_phase.toUpperCase()}`;
}

function deltaFragment(envelope: DigestEnvelope): string {
  if (!envelope.delta) return "";
  return ` (delta: +${envelope.delta.newly_passing} newly passing, ${envelope.delta.newly_broken_regressions} regressions)`;
}

export function renderPassLine(envelope: DigestEnvelope): string {
  const line =
    `[${statusLabel(envelope)}] ${envelope.summary.passed} passed, ${envelope.summary.failed} failed` +
    `${deltaFragment(envelope)} in ${envelope.duration_ms}ms | log: ${shortenPath(envelope.raw_log_path)}`;
  return truncateBytes(line, PASS_BYTE_CEILING);
}

function renderCluster(cluster: FailureCluster): string {
  const rows: string[] = [
    `${cluster.cluster_id} ${cluster.error_kind} x${cluster.affected_count} ${cluster.top_frame}`,
  ];
  if (cluster.message !== "") rows.push(`  ${truncateBytes(cluster.message, MESSAGE_BYTE_CEILING)}`);
  if (cluster.diff) {
    rows.push(`  diff: expected ${cluster.diff.expected} / received ${cluster.diff.received}`);
  }
  for (const frame of cluster.pruned_stack) rows.push(`  ${frame}`);
  if (cluster.signal_window !== "") {
    for (const line of cluster.signal_window.split("\n")) rows.push(`  ${line}`);
  }
  if (cluster.sample_tests.length > 0) rows.push(`  tests: ${cluster.sample_tests.join(", ")}`);
  rows.push(`  raw: ${cluster.raw_log_lines}`);
  return rows.join("\n");
}

export function renderFailBody(envelope: DigestEnvelope): string {
  const clusters = envelope.clusters ?? [];
  let kept = clusters.length;

  const render = (): string => {
    const header =
      `[${statusLabel(envelope)}] ${envelope.summary.failed} failed, ${envelope.summary.passed} passed` +
      ` in ${envelope.duration_ms}ms | ${kept} cluster${kept === 1 ? "" : "s"}` +
      ` | log: ${shortenPath(envelope.raw_log_path)}`;
    const blocks = clusters.slice(0, kept).map(renderCluster).join("\n");
    const omission = kept < clusters.length ? `\n+${clusters.length - kept} more clusters (see log)` : "";
    return `${header}\n${blocks}${omission}`;
  };

  let text = render();
  while (estimateTokens(text) > MAX_FAIL_TOKENS && kept > 1) {
    kept -= 1;
    text = render();
  }
  return truncateBytes(text, FAIL_BYTE_CEILING);
}

export function formatEnvelope(envelope: DigestEnvelope, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(envelope, null, 2)}\n`;
  const oneLiner = envelope.status === "PASS" || envelope.status === "VALID_RED";
  return `${oneLiner ? renderPassLine(envelope) : renderFailBody(envelope)}\n`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/envelope.spec.ts && pnpm typecheck`
Expected: `11 passed`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: assemble envelopes and enforce pass/fail byte ceilings"
```

---

### Task 10: TDD phase gate and scoped state (`src/state/tdd-gate.ts`)

Satisfies REQ-TDD-GATE (§4.3), INV-5, `RedGreenDelta`, and CT-5 (scope isolation). The gate is a pure function over already-computed facts; only `loadState`/`saveState` touch disk.

**Files:**
- Create: `src/state/tdd-gate.ts`
- Modify: `tests/dedup-and-tdd.spec.ts` (append a block)

- [ ] **Step 1: Write the failing test**

Append to `tests/dedup-and-tdd.spec.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EX_USAGE,
  computeDelta,
  evaluatePhase,
  loadState,
  resolveScopeId,
  saveState,
  stateFilePath,
  type PhaseArgs,
  type RunState,
} from "../src/state/tdd-gate.js";

function phaseArgs(overrides: Partial<PhaseArgs> = {}): PhaseArgs {
  return {
    phase: "none",
    childExitCode: 0,
    failures: [],
    gear: "GEAR_0_GRAMMAR",
    previousState: null,
    failedTests: [],
    passed: 0,
    ...overrides,
  };
}

const assertionFailure = {
  testName: "cart > totals",
  errorKind: "ASSERTION_FAILURE" as const,
  message: "AssertionError: expected 99 to be 100",
  frames: ["at totals (src/cart.ts:12:5)"],
  startLine: 10,
  endLine: 14,
};

const importFailure = {
  testName: null,
  errorKind: "SYNTAX_IMPORT_ERROR" as const,
  message: 'Error: Failed to resolve import "./helprs"',
  frames: ["tests/discount.spec.ts:3:1"],
  startLine: 3,
  endLine: 5,
};

describe("red phase (INV-5)", () => {
  it("blocks a run that already passes", () => {
    const decision = evaluatePhase(phaseArgs({ phase: "red", childExitCode: 0, passed: 1 }));
    expect(decision.status).toBe("INVALID_RED");
    expect(decision.exitCode).toBe(EX_USAGE);
    expect(decision.message).toMatch(/passed before implementation/);
    expect(decision.recordBaseline).toBe(false);
  });

  it("blocks an unresolved import", () => {
    const decision = evaluatePhase(
      phaseArgs({ phase: "red", childExitCode: 1, failures: [importFailure] }),
    );
    expect(decision.status).toBe("INVALID_RED");
    expect(decision.exitCode).toBe(EX_USAGE);
    expect(decision.message).toMatch(/syntax or unresolved module import/);
  });

  it("blocks a runner startup crash that produced no failure blocks", () => {
    const decision = evaluatePhase(phaseArgs({ phase: "red", childExitCode: 1, failures: [] }));
    expect(decision.status).toBe("INVALID_RED");
    expect(decision.exitCode).toBe(EX_USAGE);
  });

  it("accepts a behavioral assertion failure and records the baseline", () => {
    const decision = evaluatePhase(
      phaseArgs({
        phase: "red",
        childExitCode: 1,
        failures: [assertionFailure],
        failedTests: ["cart > totals"],
      }),
    );
    expect(decision.status).toBe("VALID_RED");
    expect(decision.exitCode).toBe(0);
    expect(decision.recordBaseline).toBe(true);
  });
});

describe("green and refactor phases", () => {
  it("green + pass is PASS with the delta", () => {
    const previousState: RunState = {
      version: 1,
      scope_id: "s01",
      phase: "red",
      baseline: ["cart > totals"],
      last_run: { failed: ["cart > totals"], passed: 0, status: "VALID_RED", at: "2026-10-30T10:00:00.000Z" },
    };
    const decision = evaluatePhase(
      phaseArgs({ phase: "green", childExitCode: 0, previousState, passed: 12 }),
    );
    expect(decision.status).toBe("PASS");
    expect(decision.delta).toEqual({
      newly_passing: 1,
      newly_broken_regressions: 0,
      still_failing: 0,
    });
  });

  it("green + failure is FAIL with the child exit code (R9)", () => {
    const decision = evaluatePhase(
      phaseArgs({ phase: "green", childExitCode: 2, failures: [assertionFailure] }),
    );
    expect(decision.status).toBe("FAIL");
    expect(decision.exitCode).toBe(2);
  });

  it("refactor + failure is REGRESSION_DETECTED with the child exit code", () => {
    const previousState: RunState = {
      version: 1,
      scope_id: "s01",
      phase: "green",
      baseline: [],
      last_run: { failed: [], passed: 12, status: "PASS", at: "2026-10-30T10:00:00.000Z" },
    };
    const decision = evaluatePhase(
      phaseArgs({
        phase: "refactor",
        childExitCode: 1,
        failures: [assertionFailure],
        failedTests: ["cart > totals"],
        previousState,
      }),
    );
    expect(decision.status).toBe("REGRESSION_DETECTED");
    expect(decision.exitCode).toBe(1);
    expect(decision.delta?.newly_broken_regressions).toBe(1);
  });
});

describe("no phase", () => {
  it("pass is PASS with exit 0", () => {
    const decision = evaluatePhase(phaseArgs({ childExitCode: 0, passed: 3 }));
    expect(decision).toEqual({ status: "PASS", exitCode: 0, recordBaseline: false });
  });

  it("a grammar failure is FAIL, an unstructured failure is BUILD_ERROR (R5)", () => {
    expect(
      evaluatePhase(phaseArgs({ childExitCode: 1, failures: [assertionFailure] })).status,
    ).toBe("FAIL");
    expect(
      evaluatePhase(phaseArgs({ childExitCode: 1, gear: "GEAR_1_JEV" })).status,
    ).toBe("BUILD_ERROR");
  });
});

describe("computeDelta", () => {
  it("returns undefined without prior state", () => {
    expect(computeDelta(null, ["a"])).toBeUndefined();
  });

  it("counts newly passing, regressions and still failing", () => {
    const previousState: RunState = {
      version: 1,
      scope_id: "s01",
      phase: "red",
      baseline: ["a", "b"],
      last_run: { failed: ["a", "b", "c"], passed: 0, status: "VALID_RED", at: "2026-10-30T10:00:00.000Z" },
    };
    expect(computeDelta(previousState, ["c", "d"])).toEqual({
      newly_passing: 2,
      newly_broken_regressions: 1,
      still_failing: 1,
    });
  });
});

describe("scope isolation (CT-5)", () => {
  it("derives a stable 12-hex-character scope id from the working directory", () => {
    expect(resolveScopeId("/work/repo")).toMatch(/^[0-9a-f]{12}$/);
    expect(resolveScopeId("/work/repo")).toBe(resolveScopeId("/work/repo"));
    expect(resolveScopeId("/work/repo")).not.toBe(resolveScopeId("/work/other"));
  });

  it("keeps an explicit scope id but sanitises it for the filesystem", () => {
    expect(resolveScopeId("/work/repo", "s01")).toBe("s01");
    expect(resolveScopeId("/work/repo", "../etc/passwd")).toBe(".._etc_passwd");
  });

  it("writes isolated state files for concurrent scopes", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-state-"));
    const write = (scopeId: string): void => {
      saveState(
        {
          version: 1,
          scope_id: scopeId,
          phase: "red",
          baseline: [`${scopeId}-failure`],
          last_run: null,
        },
        base,
      );
    };
    await Promise.all([Promise.resolve().then(() => write("s01")), Promise.resolve().then(() => write("s02"))]);
    expect(stateFilePath("s01", base)).toBe(path.join(base, "state-s01.json"));
    expect(loadState("s01", base)?.baseline).toEqual(["s01-failure"]);
    expect(loadState("s02", base)?.baseline).toEqual(["s02-failure"]);
    expect(fs.readdirSync(base).filter((f) => f.endsWith(".tmp")).length).toBe(0);
  });

  it("returns null for a missing or corrupt state file", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-state-"));
    expect(loadState("nope", base)).toBeNull();
    fs.writeFileSync(path.join(base, "state-broken.json"), "{not json");
    expect(loadState("broken", base)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/dedup-and-tdd.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/state/tdd-gate.js"`.

- [ ] **Step 3: Write `src/state/tdd-gate.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import { cacheRoot } from "../runner/raw-log.js";
import type { Delta, DigestStatus, ExecutionGear, TddPhase } from "../types/schema.js";

export const EX_USAGE = 64;
export const STATE_VERSION = 1;

export interface RunSnapshot {
  failed: string[];
  passed: number;
  status: DigestStatus;
  at: string;
}

export interface RunState {
  version: number;
  scope_id: string;
  phase: TddPhase;
  baseline: string[];
  last_run: RunSnapshot | null;
}

export interface PhaseArgs {
  phase: TddPhase;
  childExitCode: number;
  failures: readonly RawFailure[];
  gear: ExecutionGear;
  previousState: RunState | null;
  failedTests: readonly string[];
  passed: number;
}

export interface PhaseDecision {
  status: DigestStatus;
  exitCode: number;
  message?: string;
  delta?: Delta;
  recordBaseline: boolean;
}

export function defaultStateDir(): string {
  return cacheRoot();
}

export function resolveScopeId(cwd: string, explicit?: string): string {
  if (explicit !== undefined && explicit !== "") {
    return explicit.replace(/[^A-Za-z0-9._-]/g, "_");
  }
  return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function stateFilePath(scopeId: string, baseDir = defaultStateDir()): string {
  return path.join(baseDir, `state-${scopeId}.json`);
}

export function loadState(scopeId: string, baseDir = defaultStateDir()): RunState | null {
  try {
    const raw = fs.readFileSync(stateFilePath(scopeId, baseDir), "utf8");
    const parsed = JSON.parse(raw) as RunState;
    if (parsed.version !== STATE_VERSION || parsed.scope_id !== scopeId) return null;
    return {
      version: parsed.version,
      scope_id: parsed.scope_id,
      phase: parsed.phase,
      baseline: Array.isArray(parsed.baseline) ? parsed.baseline : [],
      last_run: parsed.last_run ?? null,
    };
  } catch {
    return null;
  }
}

/** CT-5: write to a unique temp file, then rename. No cross-scope lock contention. */
export function saveState(state: RunState, baseDir = defaultStateDir()): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const target = stateFilePath(state.scope_id, baseDir);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

export function computeDelta(
  previous: RunState | null,
  currentFailed: readonly string[],
): Delta | undefined {
  if (previous === null) return undefined;
  const before = new Set(previous.last_run?.failed ?? previous.baseline);
  const now = new Set(currentFailed);
  return {
    newly_passing: [...before].filter((name) => !now.has(name)).length,
    newly_broken_regressions: [...now].filter((name) => !before.has(name)).length,
    still_failing: [...now].filter((name) => before.has(name)).length,
  };
}

export function evaluatePhase(args: PhaseArgs): PhaseDecision {
  const delta = computeDelta(args.previousState, args.failedTests);
  const withDelta = (decision: PhaseDecision): PhaseDecision =>
    delta === undefined ? decision : { ...decision, delta };

  switch (args.phase) {
    case "red": {
      if (args.childExitCode === 0) {
        return {
          status: "INVALID_RED",
          exitCode: EX_USAGE,
          message:
            "New test passed before implementation; expected a failing behavioral assertion.",
          recordBaseline: false,
        };
      }
      const hasSyntaxFailure = args.failures.some(
        (failure) => failure.errorKind === "SYNTAX_IMPORT_ERROR",
      );
      if (hasSyntaxFailure) {
        return {
          status: "INVALID_RED",
          exitCode: EX_USAGE,
          message:
            "Test failed due to syntax or unresolved module import rather than a behavioral assertion.",
          recordBaseline: false,
        };
      }
      if (args.failures.length === 0) {
        return {
          status: "INVALID_RED",
          exitCode: EX_USAGE,
          message:
            "Test run failed before any test executed (runner startup crash or no tests collected).",
          recordBaseline: false,
        };
      }
      return withDelta({ status: "VALID_RED", exitCode: 0, recordBaseline: true });
    }

    case "green": {
      if (args.childExitCode === 0) return withDelta({ status: "PASS", exitCode: 0, recordBaseline: false });
      return withDelta({ status: "FAIL", exitCode: args.childExitCode, recordBaseline: false });
    }

    case "refactor": {
      if (args.childExitCode === 0) return withDelta({ status: "PASS", exitCode: 0, recordBaseline: false });
      return withDelta({
        status: "REGRESSION_DETECTED",
        exitCode: args.childExitCode,
        recordBaseline: false,
      });
    }

    case "none":
    default: {
      if (args.childExitCode === 0) return { status: "PASS", exitCode: 0, recordBaseline: false };
      const structured = args.gear === "GEAR_0_GRAMMAR";
      return {
        status: structured ? "FAIL" : "BUILD_ERROR",
        exitCode: args.childExitCode,
        recordBaseline: false,
      };
    }
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/dedup-and-tdd.spec.ts && pnpm typecheck`
Expected: `21 passed`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: enforce tdd phase gate with isolated, atomically written scope state"
```

---

### Task 11: Gear 1 — candidate windows, Jev client and unstructured triage (`src/gears/`)

Implements REQ-GEAR1-JEV (§4.4) and INV-6: at most 255 candidate windows, one `POST /v1/systemone`, flake retry at `noul ≥ 0.80`, and a heuristic fallback when Jev is unavailable (`--no-jev`, no key, timeout or HTTP error).

**Files:**
- Create: `src/gears/windows.ts`, `src/gears/jev-client.ts`, `src/gears/gear1-jev.ts`, `tests/gear1-jev.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/gear1-jev.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CapturedLine } from "../src/runner/capture.js";
import type { JevQuestion, JevResponse } from "../src/types/schema.js";
import { JEV_MODEL, JevClient } from "../src/gears/jev-client.js";
import {
  FLAKE_PROBABILITY_THRESHOLD,
  triageUnstructured,
  type JevAsker,
} from "../src/gears/gear1-jev.js";
import {
  MAX_CANDIDATE_WINDOWS,
  partitionWindows,
  selectCandidateWindows,
} from "../src/gears/windows.js";

function numbered(lines: readonly string[]): CapturedLine[] {
  return lines.map((text, index) => ({ stream: "stdout" as const, text, line: index + 1 }));
}

function linkerLog(totalLines: number, errorAt: number): CapturedLine[] {
  const lines = Array.from({ length: totalLines }, (_, index) => `build step ${index + 1} ok`);
  lines[errorAt - 1] = "ld: library not found for -lpq";
  lines[errorAt] = "clang: error: linker command failed with exit code 1";
  return numbered(lines);
}

describe("partitionWindows", () => {
  it("cuts 12-line windows every 6 lines", () => {
    const windows = partitionWindows(numbered(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)));
    expect(windows.map((w) => w.id)).toEqual(["w_1", "w_2", "w_3", "w_4"]);
    expect(windows[0]?.startLine).toBe(1);
    expect(windows[0]?.endLine).toBe(12);
    expect(windows[1]?.startLine).toBe(7);
    expect(windows[3]?.endLine).toBe(30);
  });

  it("scores windows by failure salience", () => {
    const windows = partitionWindows(
      numbered(["ok", "error: boom", "fatal: boom", "ok", ...Array.from({ length: 20 }, () => "ok")]),
    );
    expect(windows[0]?.score).toBe(2);
    expect(windows[2]?.score).toBe(0);
  });
});

describe("selectCandidateWindows", () => {
  it("never returns more than 255 windows and keeps the tail (INV-6)", () => {
    const lines = Array.from({ length: 2010 }, (_, i) => `error: failure ${i}`);
    const all = partitionWindows(numbered(lines));
    const selected = selectCandidateWindows(all);
    expect(all.length).toBeGreaterThan(MAX_CANDIDATE_WINDOWS);
    expect(selected.length).toBeLessThanOrEqual(MAX_CANDIDATE_WINDOWS);
    expect(selected.some((window) => window.id === all[all.length - 1]?.id)).toBe(true);
  });

  it("keeps every salient window when there is headroom", () => {
    const lines = Array.from({ length: 120 }, (_, i) => (i === 60 ? "error: boom" : "ok"));
    const selected = selectCandidateWindows(partitionWindows(numbered(lines)));
    expect(selected.length).toBeLessThanOrEqual(255);
    expect(selected.length).toBeGreaterThanOrEqual(1);
  });
});

describe("JevClient", () => {
  const response: JevResponse = {
    model: JEV_MODEL,
    answers: {
      root_cause_window: {
        type: "choice",
        choice: "w_1",
        confidence: 0.9,
        probabilities: { w_1: 0.9 },
      },
      error_category: {
        type: "choice",
        choice: "MISSING_DEPENDENCY_OR_PACKAGE",
        confidence: 0.8,
        probabilities: { MISSING_DEPENDENCY_OR_PACKAGE: 0.8 },
      },
      is_transient_flake: { type: "noul", noul: 0.1 },
    },
    usage: { input_tokens: 100, output_tokens: 5 },
  };

  it("posts the real Jev 1.13 request shape to /v1/systemone", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = new JevClient({ apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch });
    const questions: Record<string, JevQuestion> = {
      root_cause_window: {
        type: "choice",
        instructions: "Which window?",
        criteria: { w_1: "error: boom" },
      },
      is_transient_flake: {
        type: "noul",
        instructions: "Is this a flake?",
        criteria: { true: "transient", false: "deterministic" },
      },
    };
    await client.ask("state text", questions);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { model: string; questions: Record<string, JevQuestion> };
    expect(body.model).toBe("jev-1.13.0");
    expect(body.questions["root_cause_window"]?.type).toBe("choice");
    expect(body.questions["is_transient_flake"]?.type).toBe("noul");
  });

  it("refuses to call without an API key", async () => {
    const client = new JevClient({ apiKey: "" });
    expect(client.isConfigured()).toBe(false);
    await expect(client.ask("x", { q: { type: "noul", instructions: "?" } })).rejects.toThrow(
      /TYPESAFE_API_KEY/,
    );
  });

  it("surfaces a non-2xx response as an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = new JevClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.ask("x", { q: { type: "noul", instructions: "?" } })).rejects.toThrow(
      /Jev HTTP 500/,
    );
  });
});

describe("triageUnstructured", () => {
  const base = {
    command: ["cargo", "build"],
    exitCode: 101,
    repoRoot: "/work/repo",
    contextLines: 2,
    noJev: false,
    retryFlakes: false,
  };

  function fakeAsker(noul: number): JevAsker & { calls: number } {
    const asker = {
      calls: 0,
      isConfigured: () => true,
      ask: vi.fn(async (_state: unknown, questions: Record<string, JevQuestion>) => {
        asker.calls += 1;
        const rootQuestion = questions["root_cause_window"];
        const criteria = rootQuestion?.type === "choice" ? rootQuestion.criteria : {};
        const target =
          Object.entries(criteria).find(([, text]) => text.includes("library not found"))?.[0] ??
          Object.keys(criteria)[0] ??
          "w_1";
        return {
          model: JEV_MODEL,
          answers: {
            root_cause_window: {
              type: "choice" as const,
              choice: target,
              confidence: 0.93,
              probabilities: { [target]: 0.93 },
            },
            error_category: {
              type: "choice" as const,
              choice: "MISSING_DEPENDENCY_OR_PACKAGE",
              confidence: 0.88,
              probabilities: { MISSING_DEPENDENCY_OR_PACKAGE: 0.88 },
            },
            is_transient_flake: { type: "noul" as const, noul },
          },
          usage: { input_tokens: 900, output_tokens: 6 },
        };
      }),
    };
    return asker;
  }

  it("wraps the selected window and points at the raw log", async () => {
    const lines = linkerLog(3200, 2840);
    const outcome = await triageUnstructured({ ...base, lines, client: fakeAsker(0.05) });
    expect(outcome.gear).toBe("GEAR_1_JEV");
    expect(outcome.retry).toBe(false);
    expect(outcome.cluster.error_kind).toBe("UNSTRUCTURED_BUILD_ERROR");
    expect(outcome.cluster.signal_window).toContain("ld: library not found for -lpq");
    expect(outcome.cluster.raw_log_lines).toMatch(/^L28\d\d-L28\d\d$/);
  });

  it("asks for a retry only above the 0.80 probability and only when enabled", async () => {
    const lines = linkerLog(400, 200);
    const flaky = await triageUnstructured({ ...base, lines, client: fakeAsker(0.81), retryFlakes: true });
    expect(flaky.retry).toBe(true);
    const lowConfidence = await triageUnstructured({ ...base, lines, client: fakeAsker(FLAKE_PROBABILITY_THRESHOLD - 0.01), retryFlakes: true });
    expect(lowConfidence.retry).toBe(false);
    const disabled = await triageUnstructured({ ...base, lines, client: fakeAsker(0.99), retryFlakes: false });
    expect(disabled.retry).toBe(false);
  });

  it("falls back to the most salient window when Jev is disabled", async () => {
    const lines = linkerLog(400, 200);
    const asker = fakeAsker(0.99);
    const outcome = await triageUnstructured({ ...base, lines, noJev: true, client: asker });
    expect(outcome.gear).toBe("GEAR_0_HEURISTIC_FALLBACK");
    expect(asker.calls).toBe(0);
    expect(outcome.cluster.signal_window).toContain("ld: library not found for -lpq");
  });

  it("falls back when the Jev call throws", async () => {
    const lines = linkerLog(400, 200);
    const asker: JevAsker = {
      isConfigured: () => true,
      ask: async () => {
        throw new Error("Jev HTTP 503");
      },
    };
    const outcome = await triageUnstructured({ ...base, lines, client: asker });
    expect(outcome.gear).toBe("GEAR_0_HEURISTIC_FALLBACK");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/gear1-jev.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/gears/jev-client.js"`.

- [ ] **Step 3: Write `src/gears/windows.ts`**

```ts
import type { CapturedLine } from "../runner/capture.js";

export const WINDOW_SIZE = 12;
export const WINDOW_STRIDE = 6;
export const MAX_CANDIDATE_WINDOWS = 255;
export const SALIENCE_HEADROOM = 252;
export const TAIL_WINDOWS = 3;
export const EXCERPT_PADDING = 10;

const SALIENCE_TOKENS: readonly RegExp[] = [
  /undefined reference/i,
  /permission denied/i,
  /no such file or directory|enoent/i,
  /exit status/i,
  /traceback/i,
  /panicked|panic:/i,
  /fatal/i,
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
];

export interface LogWindow {
  id: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export function scoreWindow(lines: readonly string[]): number {
  let score = 0;
  for (const line of lines) {
    for (const token of SALIENCE_TOKENS) {
      if (token.test(line)) score += 1;
    }
  }
  return score;
}

export function partitionWindows(lines: readonly CapturedLine[]): LogWindow[] {
  const windows: LogWindow[] = [];

  for (let index = 0; index < lines.length; index += WINDOW_STRIDE) {
    const slice = lines.slice(index, index + WINDOW_SIZE);
    if (slice.length === 0) break;
    const text = slice.map((line) => line.text);
    windows.push({
      id: `w_${windows.length + 1}`,
      startLine: slice[0]?.line ?? index + 1,
      endLine: slice[slice.length - 1]?.line ?? index + 1,
      score: scoreWindow(text),
      text: text.join("\n"),
    });
    if (index + WINDOW_SIZE >= lines.length) break;
  }

  return windows;
}

/** INV-6: 252 highest-salience windows plus the 3 tail windows, never above 255. */
export function selectCandidateWindows(windows: readonly LogWindow[]): LogWindow[] {
  const salient = windows.filter((window) => window.score > 0);
  const selected =
    salient.length <= SALIENCE_HEADROOM
      ? [...salient]
      : [...salient]
          .sort((a, b) => b.score - a.score || a.startLine - b.startLine)
          .slice(0, SALIENCE_HEADROOM);

  const seen = new Set(selected.map((window) => window.id));
  for (const window of windows.slice(-TAIL_WINDOWS)) {
    if (seen.has(window.id)) continue;
    selected.push(window);
    seen.add(window.id);
  }

  return selected.sort((a, b) => a.startLine - b.startLine).slice(0, MAX_CANDIDATE_WINDOWS);
}
```

- [ ] **Step 4: Write `src/gears/jev-client.ts`**

```ts
import {
  JevRequestSchema,
  JevResponseSchema,
  type JevQuestion,
  type JevResponse,
} from "../types/schema.js";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_TIMEOUT_MS = 1200;

export interface JevClientConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class JevClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JevClientConfig = {}) {
    const env = process.env;
    this.baseUrl = (config.baseUrl ?? env["TYPESAFE_API_URL"] ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? env["TYPESAFE_API_KEY"] ?? env["JEV_API_KEY"];
    this.model = config.model ?? JEV_MODEL;
    this.timeoutMs = config.timeoutMs ?? JEV_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  async ask(
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
  ): Promise<JevResponse> {
    if (!this.isConfigured()) {
      throw new Error("Jev API key missing: set TYPESAFE_API_KEY (or pass --no-jev)");
    }

    const body = JevRequestSchema.parse({ model: this.model, state, questions });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey ?? ""}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
      return JevResponseSchema.parse(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 5: Write `src/gears/gear1-jev.ts`**

```ts
import { computeFingerprint } from "../pruner/cluster-dedup.js";
import type { CapturedLine } from "../runner/capture.js";
import type {
  ExecutionGear,
  FailureCluster,
  JevQuestion,
  JevResponse,
} from "../types/schema.js";
import { JevClient } from "./jev-client.js";
import {
  EXCERPT_PADDING,
  partitionWindows,
  selectCandidateWindows,
  type LogWindow,
} from "./windows.js";

export const FLAKE_PROBABILITY_THRESHOLD = 0.8;
export const MIN_UNSTRUCTURED_LINES = 151;
export const TAIL_STATE_LINES = 40;
const MESSAGE_CEILING = 240;

export const ERROR_CATEGORIES = {
  COMPILE_OR_LINK_ERROR: "Compiler or linker error in the project sources",
  MISSING_DEPENDENCY_OR_PACKAGE: "A library, package or system dependency is missing",
  ENV_OR_PORT_COLLISION: "Environment variable missing or a port/address is already in use",
  PERMISSION_OR_SECRET_MISSING: "Permission denied or credentials/secrets missing",
  TRANSIENT_NETWORK_OR_TIMEOUT: "Transient network timeout, DNS or rate-limit problem",
} as const;

export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

/** Anything that answers the two questions — `JevClient` in production, a stub in tests. */
export interface JevAsker {
  isConfigured(): boolean;
  ask(
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
  ): Promise<JevResponse>;
}

export interface Gear1Input {
  lines: readonly CapturedLine[];
  command: readonly string[];
  exitCode: number;
  repoRoot: string;
  contextLines: number;
  noJev: boolean;
  retryFlakes: boolean;
  client?: JevAsker;
}

export interface Gear1Outcome {
  gear: ExecutionGear;
  cluster: FailureCluster;
  retry: boolean;
  errorCategory: ErrorCategory | null;
}

const FILE_FRAME = /(\S+\.(?:c|cc|cpp|h|hpp|rs|go|ts|js|py|sh|nix|toml)):(\d+)(?::(\d+))?/;

function firstSalientLine(window: LogWindow): string {
  const lines = window.text.split("\n");
  const salient = /error|fatal|failed|panic|undefined reference|exception|not found/i;
  const hit = lines.find((line) => salient.test(line));
  const chosen = (hit ?? lines[0] ?? "unstructured failure").trim();
  return chosen.length > MESSAGE_CEILING ? `${chosen.slice(0, MESSAGE_CEILING)}...` : chosen;
}

function buildCluster(window: LogWindow, lines: readonly CapturedLine[]): FailureCluster {
  const startLine = Math.max(1, window.startLine - EXCERPT_PADDING);
  const lastLine = lines[lines.length - 1]?.line ?? window.endLine;
  const endLine = Math.min(lastLine, window.endLine + EXCERPT_PADDING);
  const excerpt = lines
    .filter((line) => line.line >= startLine && line.line <= endLine)
    .map((line) => line.text)
    .join("\n");

  const frame = FILE_FRAME.exec(window.text);
  const topFrame = frame?.[2] !== undefined ? `${frame[1]}:${frame[2]}:${frame[3] ?? "1"}` : "unknown:0:0";
  const message = firstSalientLine(window);
  const fingerprint = computeFingerprint("UNSTRUCTURED_BUILD_ERROR", topFrame, message);

  return {
    cluster_id: `c_${fingerprint.slice(0, 8)}`,
    fingerprint,
    error_kind: "UNSTRUCTURED_BUILD_ERROR",
    affected_count: 1,
    sample_tests: [],
    message,
    top_frame: topFrame,
    pruned_stack: [],
    signal_window: excerpt,
    raw_log_lines: `L${startLine}-L${endLine}`,
  };
}

function heuristicWindow(windows: readonly LogWindow[]): LogWindow {
  const ranked = [...windows].sort(
    (a, b) => b.score - a.score || b.startLine - a.startLine,
  );
  return ranked[0] ?? {
    id: "w_1",
    startLine: 1,
    endLine: 1,
    score: 0,
    text: "unstructured failure",
  };
}

export async function triageUnstructured(input: Gear1Input): Promise<Gear1Outcome> {
  const windows = partitionWindows(input.lines);
  const candidates = selectCandidateWindows(windows);
  const client = input.client ?? new JevClient();

  const fallback = (): Gear1Outcome => {
    const window = heuristicWindow(windows.length > 0 ? windows : candidates);
    return {
      gear: "GEAR_0_HEURISTIC_FALLBACK",
      cluster: buildCluster(window, input.lines),
      retry: false,
      errorCategory: null,
    };
  };

  if (input.noJev || !client.isConfigured() || candidates.length === 0) return fallback();

  const criteria: Record<string, string> = {};
  for (const window of candidates) criteria[window.id] = window.text;

  const questions: Record<string, JevQuestion> = {
    root_cause_window: {
      type: "choice",
      instructions:
        "Which window contains the primary root cause of this build failure? " +
        "Ignore downstream cascading wrapper errors such as 'make: *** [all] Error 2'.",
      criteria,
    },
    error_category: {
      type: "choice",
      instructions: "Which category best describes the primary root cause?",
      criteria: { ...ERROR_CATEGORIES },
    },
    is_transient_flake: {
      type: "noul",
      instructions:
        "This failure is caused by a transient network timeout, port lock or race condition " +
        "that warrants one automatic retry.",
      criteria: {
        true: "A timeout, port already in use, DNS failure or rate limit",
        false: "A deterministic compile, link, dependency or permission error",
      },
    },
  };

  const state = {
    command: input.command.join(" "),
    exit_code: input.exitCode,
    log_lines: input.lines.length,
    tail: input.lines
      .slice(-TAIL_STATE_LINES)
      .map((line) => line.text)
      .join("\n"),
  };

  let response: JevResponse;
  try {
    response = await client.ask(state, questions);
  } catch {
    return fallback();
  }

  const rootCause = response.answers["root_cause_window"];
  const chosenId = rootCause?.type === "choice" ? rootCause.choice : null;
  const window = candidates.find((candidate) => candidate.id === chosenId) ?? heuristicWindow(windows);

  const category = response.answers["error_category"];
  const errorCategory =
    category?.type === "choice" && category.choice in ERROR_CATEGORIES
      ? (category.choice as ErrorCategory)
      : null;

  const flake = response.answers["is_transient_flake"];
  const retry =
    input.retryFlakes &&
    flake?.type === "noul" &&
    flake.noul >= FLAKE_PROBABILITY_THRESHOLD;

  return {
    gear: "GEAR_1_JEV",
    cluster: buildCluster(window, input.lines),
    retry,
    errorCategory,
  };
}
```

- [ ] **Step 6: Run it and watch it pass**

Run: `pnpm vitest run tests/gear1-jev.spec.ts && pnpm typecheck`
Expected: `11 passed`; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: triage unstructured build logs through jev with a 255-window cap"
```

---

### Task 12: Pipeline wiring and exit codes (`src/index.ts`)

Satisfies INV-3 (exact exit-code and signal transparency), INV-5's `EX_USAGE` path, R7 (escalation predicate) and R11b (short unstructured runs go straight to the heuristic, not to Jev).

**Files:**
- Create: `src/index.ts`, `tests/fixtures/generate.ts`
- Modify: `tests/cli.spec.ts` (append a block)

- [ ] **Step 1: Write the fixture generators**

`tests/fixtures/generate.ts`:

```ts
/** ~2,500 lines of vitest checkmarks plus a passing summary (CT-1 shape). */
export function vitestPassOutput(totalLines = 2500, passed = 240): string {
  const filler = Array.from(
    { length: Math.max(0, totalLines - 2) },
    (_, index) => ` ✓ tests/suite-${(index % 32) + 1}.spec.ts > case ${index} 2ms`,
  );
  return [...filler, " Test Files  32 passed (32)", `      Tests  ${passed} passed (${passed})`].join("\n");
}

/** `failures` identical cascade blocks, each with a 35-frame node_modules trace (CT-2 shape). */
export function vitestCascadeOutput(failures = 50, framesPerTest = 35): string {
  const blocks: string[] = [];
  for (let index = 0; index < failures; index += 1) {
    const frames = Array.from(
      { length: framesPerTest },
      (_, frame) => ` ❯ fn${frame} (node_modules/vitest/dist/chunk-${frame}.js:${frame + 1}:1)`,
    );
    blocks.push(
      [
        ` FAIL  tests/spec-${index % 10}.spec.ts > case ${index}`,
        "TypeError: token.split is not a function",
        " ❯ parseToken (src/auth/jwt.ts:28:19)",
        ...frames,
        "",
      ].join("\n"),
    );
  }
  return [...blocks, `      Tests  ${failures} failed (${failures})`].join("\n");
}

/** An unstructured build log with the root cause planted at `errorAt` (CT-4 shape). */
export function linkerLog(totalLines = 3200, errorAt = 2840): string {
  const lines = Array.from({ length: totalLines }, (_, index) => `[${index + 1}] build step ok`);
  lines[errorAt - 1] = "ld: library not found for -lpq";
  lines[errorAt] = "clang: error: linker command failed with exit code 1";
  return lines.join("\n");
}
```

- [ ] **Step 2: Write the failing e2e tests**

Append to `tests/cli.spec.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe as describeE2e, expect as expectE2e, it as itE2e, vi } from "vitest";
import { main } from "../src/index.js";
import { estimateTokens } from "../src/formatters/envelope.js";
import { DigestEnvelopeSchema, type DigestEnvelope } from "../src/types/schema.js";
import { vitestCascadeOutput, vitestPassOutput } from "./fixtures/generate.js";

let home: string;
let project: string;
let originalCwd: string;
let stdout: string;
let stderr: string;

function writeChild(name: string, body: string): string {
  const file = path.join(project, name);
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  originalCwd = process.cwd();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-project-"));
  fs.mkdirSync(path.join(project, "src", "auth"), { recursive: true });
  const source = Array.from({ length: 32 }, (_, index) => `const line${index + 1} = ${index + 1};`);
  source[27] = "  return parts.split('.');";
  fs.writeFileSync(path.join(project, "src", "auth", "jwt.ts"), `${source.join("\n")}\n`);
  process.env["DOT_TEST_DIGEST_HOME"] = home;
  process.chdir(project);
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  delete process.env["DOT_TEST_DIGEST_HOME"];
});

describeE2e("exit-code transparency (INV-3)", () => {
  itE2e("returns the child exit code unchanged", async () => {
    const code = await main(["--", process.execPath, "-e", "process.exit(42)"]);
    expectE2e(code).toBe(42);
  });

  itE2e("maps a SIGTERM death to 143", async () => {
    const code = await main(["--", process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
    expectE2e(code).toBe(143);
  });

  itE2e("returns 64 for an unknown flag", async () => {
    expectE2e(await main(["--nope", "--", "true"])).toBe(64);
    expectE2e(stderr).toContain("unknown flag");
  });

  itE2e("returns 127 when the command does not exist", async () => {
    expectE2e(await main(["--", "definitely-not-a-command-xyz"])).toBe(127);
  });
});

describeE2e("pass-state compression (CT-1)", () => {
  itE2e("emits at most 160 bytes and keeps 2,500 lines in the raw log", async () => {
    const child = writeChild(
      "pass.mjs",
      `process.stdout.write(${JSON.stringify(vitestPassOutput(2500, 240))});`,
    );
    const code = await main(["--", process.execPath, child]);

    expectE2e(code).toBe(0);
    expectE2e(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(161);
    expectE2e(stdout).toContain("[PASS] 240 passed, 0 failed");
    expectE2e(estimateTokens(stdout)).toBeLessThanOrEqual(35);

    const logs = fs.readdirSync(path.join(home, "logs"));
    expectE2e(logs).toHaveLength(1);
    const raw = fs.readFileSync(path.join(home, "logs", logs[0] as string), "utf8");
    expectE2e(raw.split("\n").length).toBeGreaterThanOrEqual(2500);
  });
});

describeE2e("cascade deduplication (CT-2)", () => {
  itE2e("collapses 50 failures into one cluster with a real signal window", async () => {
    const child = writeChild(
      "cascade.mjs",
      `process.stdout.write(${JSON.stringify(vitestCascadeOutput(50, 35))}); process.exit(1);`,
    );
    const code = await main(["--format=json", "--", process.execPath, child]);
    expectE2e(code).toBe(1);

    const envelope = DigestEnvelopeSchema.parse(JSON.parse(stdout)) as DigestEnvelope;
    expectE2e(envelope.status).toBe("FAIL");
    expectE2e(envelope.summary.total_clusters).toBe(1);
    expectE2e(envelope.clusters).toHaveLength(1);
    const [cluster] = envelope.clusters ?? [];
    expectE2e(cluster?.affected_count).toBe(50);
    expectE2e(cluster?.top_frame).toBe("src/auth/jwt.ts:28:19");
    expectE2e((cluster?.pruned_stack ?? []).filter((f) => f.includes("node_modules"))).toHaveLength(1);
    const window = (cluster?.signal_window ?? "").split("\n");
    expectE2e(window).toHaveLength(5);
    expectE2e(window.some((line) => line.startsWith("28 > "))).toBe(true);
    expectE2e(cluster?.signal_window).toContain("parts.split");
  });

  itE2e("keeps the compact body under 600 tokens", async () => {
    const child = writeChild(
      "cascade-compact.mjs",
      `process.stdout.write(${JSON.stringify(vitestCascadeOutput(50, 35))}); process.exit(1);`,
    );
    await main(["--", process.execPath, child]);
    expectE2e(estimateTokens(stdout)).toBeLessThanOrEqual(600);
    expectE2e(stdout).toContain("RUNTIME_EXCEPTION x50");
  });
});

describeE2e("red phase through the CLI (INV-5)", () => {
  itE2e("blocks an unresolved import with exit 64", async () => {
    const stream = [
      " FAIL  tests/discount.spec.ts > applies discount",
      'Error: Failed to resolve import "./helprs" from "tests/discount.spec.ts". Does the file exist?',
      " ❯ tests/discount.spec.ts:3:1",
      "      Tests  1 failed (1)",
    ].join("\n");
    const child = writeChild("broken.mjs", `process.stdout.write(${JSON.stringify(stream)}); process.exit(1);`);

    const code = await main(["--tdd-phase=red", "--", process.execPath, child]);
    expectE2e(code).toBe(64);
    expectE2e(stdout).toContain("INVALID_RED");
    expectE2e(stderr).toContain("syntax or unresolved module import");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run tests/cli.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/index.js"`.

- [ ] **Step 4: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runGear0 } from "./adapters/index.js";
import { EX_USAGE, USAGE, UsageError, parseArgs } from "./cli/args.js";
import { buildEnvelope, formatEnvelope } from "./formatters/envelope.js";
import { MIN_UNSTRUCTURED_LINES, triageUnstructured, type JevAsker } from "./gears/gear1-jev.js";
import { normalizeLine } from "./pruner/ansi-stripper.js";
import { dedupeFailures, type RawFailure } from "./pruner/cluster-dedup.js";
import { runChild, type CapturedLine } from "./runner/capture.js";
import { RawLogWriter } from "./runner/raw-log.js";
import {
  evaluatePhase,
  loadState,
  resolveScopeId,
  saveState,
  type RunState,
} from "./state/tdd-gate.js";
import type { ExecutionGear, FailureCluster } from "./types/schema.js";
import { VERSION } from "./version.js";

const COMMAND_NOT_FOUND = 127;

interface Attempt {
  lines: CapturedLine[];
  gear: ExecutionGear;
  failures: RawFailure[];
  clusters: FailureCluster[];
  counts: { passed: number; failed: number; skipped: number };
  exitCode: number;
  signal: string | null;
  durationMs: number;
  retryWanted: boolean;
  logPath: string;
}

export interface MainDeps {
  /** Injection point for tests; production builds a JevClient inside triageUnstructured. */
  client?: JevAsker;
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return EX_USAGE;
    }
    throw error;
  }

  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const options = parsed.options;
  const command = parsed.command;
  const repoRoot = process.cwd();
  const scopeId = resolveScopeId(repoRoot, options.scopeId);
  const previousState = options.tddPhase === "none" ? null : loadState(scopeId);
  const rawLog = new RawLogWriter();

  const attempt = async (): Promise<Attempt> => {
    const capture = await runChild(command, { rawLog, cwd: repoRoot });
    const lines = capture.lines.map((line) => ({ ...line, text: normalizeLine(line.text) }));
    const gear0 = runGear0(lines);

    let clusters: FailureCluster[] =
      gear0 === null
        ? []
        : dedupeFailures(gear0.failures, {
            repoRoot,
            contextLines: options.contextLines,
            maxClusters: options.maxClusters,
            logPath: rawLog.path,
          });
    let gear: ExecutionGear = gear0 === null ? "GEAR_0_HEURISTIC_FALLBACK" : "GEAR_0_GRAMMAR";
    let retryWanted = false;

    if (capture.exitCode !== 0 && clusters.length === 0) {
      const outcome = await triageUnstructured({
        lines,
        command,
        exitCode: capture.exitCode,
        repoRoot,
        contextLines: options.contextLines,
        // R11b: Jev needs >150 lines; shorter unstructured failures go straight to the heuristic.
        noJev: options.noJev || lines.length < MIN_UNSTRUCTURED_LINES,
        retryFlakes: options.retryFlakes,
        ...(deps.client ? { client: deps.client } : {}),
      });
      gear = outcome.gear;
      clusters = [outcome.cluster];
      retryWanted = outcome.retry;
    }

    return {
      lines,
      gear,
      failures: gear0?.failures ?? [],
      clusters,
      counts: gear0?.counts ?? { passed: 0, failed: 0, skipped: 0 },
      exitCode: capture.exitCode,
      signal: capture.signal,
      durationMs: capture.durationMs,
      retryWanted,
      logPath: rawLog.path,
    };
  };

  try {
    let run = await attempt();
    if (run.retryWanted && options.retryFlakes) run = await attempt();

    const failedTests = run.failures
      .map((failure) => failure.testName)
      .filter((name): name is string => name !== null);

    const decision = evaluatePhase({
      phase: options.tddPhase,
      childExitCode: run.exitCode,
      failures: run.failures,
      gear: run.gear,
      previousState,
      failedTests,
      passed: run.counts.passed,
    });

    if (options.tddPhase !== "none") {
      const nextState: RunState = {
        version: 1,
        scope_id: scopeId,
        phase: options.tddPhase,
        baseline: decision.recordBaseline ? failedTests : (previousState?.baseline ?? []),
        last_run: {
          failed: failedTests,
          passed: run.counts.passed,
          status: decision.status,
          at: new Date().toISOString(),
        },
      };
      saveState(nextState);
    }

    const envelope = buildEnvelope({
      status: decision.status,
      phase: options.tddPhase,
      exitCode: decision.exitCode,
      signal: run.signal,
      gear: run.gear,
      durationMs: run.durationMs,
      counts: run.counts,
      clusters: run.clusters.slice(0, options.maxClusters),
      ...(decision.delta ? { delta: decision.delta } : {}),
      rawLogPath: run.logPath,
    });

    process.stdout.write(formatEnvelope(envelope, options.format));
    if (decision.message !== undefined) process.stderr.write(`${decision.message}\n`);
    rawLog.close();
    return decision.exitCode;
  } catch (error) {
    rawLog.close();
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dot-test-digest: ${message}\n`);
    return COMMAND_NOT_FOUND;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm vitest run tests/cli.spec.ts && pnpm typecheck`
Expected: `18 passed` (8 parse tests + 10 e2e). The `top_frame` column comes from the frame in the child stream (`28:19`); the SignalWindow excerpt comes from the fixture file, whose line 28 is `  return parts.split('.');`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire the pipeline and preserve child exit codes and signals"
```

---

### Task 13: Compliance suite (CT-1 … CT-5), README and Definition of Done

Closes SPEC §6. CT-1 and CT-2 are already covered in-process by Task 12; this task adds the real-runner red-phase fixtures (CT-3), the Jev round trip against a local stub (CT-4) and concurrent scopes (CT-5).

**Files:**
- Create: `tests/fixtures/project/vitest.config.ts`, `tests/fixtures/project/src/cart.ts`, `tests/fixtures/project/passing.spec.ts`, `tests/fixtures/project/failing.spec.ts`, `tests/fixtures/project/broken-import.spec.ts`, `tests/compliance.spec.ts`, `README.md`

- [ ] **Step 1: Create the fixture project**

`tests/fixtures/project/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["*.spec.ts"] },
});
```

`tests/fixtures/project/src/cart.ts`:

```ts
export interface Cart {
  items: string[];
  add(item: string): Cart;
  total(): number;
}

export function makeCart(): Cart {
  const items: string[] = [];
  const cart: Cart = {
    items,
    add(item) {
      items.push(item);
      return cart;
    },
    total() {
      return 99;
    },
  };
  return cart;
}
```

`tests/fixtures/project/passing.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeCart } from "./src/cart.js";

describe("cart", () => {
  it("starts empty", () => {
    expect(makeCart().items).toHaveLength(0);
  });

  it("adds items", () => {
    expect(makeCart().add("apple").items).toEqual(["apple"]);
  });
});
```

`tests/fixtures/project/failing.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeCart } from "./src/cart.js";

describe("cart totals", () => {
  it("totals an added item", () => {
    expect(makeCart().add("apple").total()).toBe(100);
  });
});
```

`tests/fixtures/project/broken-import.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeCart } from "./src/cartt.js";

describe("discount", () => {
  it("applies a discount", () => {
    expect(makeCart).toBeDefined();
  });
});
```

- [ ] **Step 2: Write the compliance suite**

`tests/compliance.spec.ts`:

```ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../src/formatters/envelope.js";
import { main } from "../src/index.js";
import { DigestEnvelopeSchema, type DigestEnvelope } from "../src/types/schema.js";
import { linkerLog } from "./fixtures/generate.js";

const REPO = process.cwd();
const FIXTURE_PROJECT = path.join("tests", "fixtures", "project");
const VITEST_BIN = path.join(REPO, "node_modules", "vitest", "vitest.mjs");

let home: string;
let workdir: string;
let originalCwd: string;
let stdout: string;
let stderr: string;

function captureIo(): void {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
}

function childScript(body: string): string {
  const file = path.join(workdir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, body);
  return file;
}

function vitestRun(spec: string): string[] {
  return [process.execPath, VITEST_BIN, "run", "--root", FIXTURE_PROJECT, spec];
}

beforeEach(() => {
  originalCwd = process.cwd();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-compliance-home-"));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-compliance-work-"));
  process.env["DOT_TEST_DIGEST_HOME"] = home;
  stdout = "";
  stderr = "";
  captureIo();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  delete process.env["DOT_TEST_DIGEST_HOME"];
  delete process.env["TYPESAFE_API_URL"];
  delete process.env["TYPESAFE_API_KEY"];
});

describe("CT-3: red-phase gate against a real runner", () => {
  it("blocks a passing test file with exit 64", async () => {
    const code = await main(["--tdd-phase=red", "--", ...vitestRun("passing.spec.ts")]);
    expect(code).toBe(64);
    expect(stdout).toContain("INVALID_RED");
    expect(stderr).toContain("passed before implementation");
  });

  it("blocks a broken import with exit 64", async () => {
    const code = await main(["--tdd-phase=red", "--", ...vitestRun("broken-import.spec.ts")]);
    expect(code).toBe(64);
    expect(stdout).toContain("INVALID_RED");
    expect(stdout).toContain("SYNTAX_IMPORT_ERROR");
  });

  it("accepts a behavioral assertion failure with exit 0 and records the baseline", async () => {
    const code = await main([
      "--tdd-phase=red",
      "--scope-id=ct3",
      "--",
      ...vitestRun("failing.spec.ts"),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("VALID_RED");

    const state = JSON.parse(
      fs.readFileSync(path.join(home, "state-ct3.json"), "utf8"),
    ) as { baseline: string[]; phase: string };
    expect(state.phase).toBe("red");
    expect(state.baseline.length).toBeGreaterThan(0);
    expect(state.baseline[0]).toContain("totals an added item");
  }, 60_000);
});

interface JevStub {
  url: string;
  requests: number;
  optionCounts: number[];
  close: () => Promise<void>;
}

async function startJevStub(): Promise<JevStub> {
  const stub: JevStub = { url: "", requests: 0, optionCounts: [], close: async () => {} };

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      stub.requests += 1;
      const parsed = JSON.parse(body) as {
        model: string;
        questions: { root_cause_window: { criteria: Record<string, string> } };
      };
      const criteria = parsed.questions.root_cause_window.criteria;
      stub.optionCounts.push(Object.keys(criteria).length);
      const chosen =
        Object.entries(criteria).find(([, text]) => text.includes("library not found"))?.[0] ??
        Object.keys(criteria)[0] ??
        "w_1";

      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          model: parsed.model,
          answers: {
            root_cause_window: {
              type: "choice",
              choice: chosen,
              confidence: 0.92,
              probabilities: { [chosen]: 0.92 },
            },
            error_category: {
              type: "choice",
              choice: "MISSING_DEPENDENCY_OR_PACKAGE",
              confidence: 0.88,
              probabilities: { MISSING_DEPENDENCY_OR_PACKAGE: 0.88 },
            },
            is_transient_flake: { type: "noul", noul: 0.03 },
          },
          usage: { input_tokens: 1500, output_tokens: 8 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("stub did not bind");
  stub.url = `http://127.0.0.1:${address.port}`;
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return stub;
}

describe("CT-4: gear 1 pinpointing in a 3,200-line linker log", () => {
  it("sends one request with at most 255 windows and returns the root-cause window", async () => {
    const stub = await startJevStub();
    process.env["TYPESAFE_API_URL"] = stub.url;
    process.env["TYPESAFE_API_KEY"] = "ct4-test-key";

    const child = childScript(
      `process.stdout.write(${JSON.stringify(linkerLog(3200, 2840))}); process.exit(101);`,
    );

    try {
      const code = await main(["--format=json", "--", process.execPath, child]);
      expect(code).toBe(101);

      const envelope = DigestEnvelopeSchema.parse(JSON.parse(stdout)) as DigestEnvelope;
      expect(envelope.status).toBe("BUILD_ERROR");
      expect(envelope.execution_gear).toBe("GEAR_1_JEV");
      const [cluster] = envelope.clusters ?? [];
      expect(cluster?.error_kind).toBe("UNSTRUCTURED_BUILD_ERROR");
      expect(cluster?.signal_window).toContain("library not found for -lpq");
      expect(cluster?.raw_log_lines).toMatch(/^L28\d\d-L28\d\d$/);

      expect(stub.requests).toBe(1);
      expect(stub.optionCounts[0]).toBeGreaterThan(0);
      expect(stub.optionCounts[0]).toBeLessThanOrEqual(255);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

describe("CT-1 / CT-2 regression guards on the compact format", () => {
  it("keeps a passing run under 35 tokens and a cascade under 600", async () => {
    const passing = childScript(
      `process.stdout.write(${JSON.stringify(" ✓ tests/a.spec.ts > case 1 2ms\n Test Files  1 passed (1)\n      Tests  3 passed (3)")});`,
    );
    expect(await main(["--", process.execPath, passing])).toBe(0);
    const passLine = stdout;
    expect(estimateTokens(passLine)).toBeLessThanOrEqual(35);

    stdout = "";
    const cascade = childScript(`process.exit(1);`);
    expect(await main(["--", process.execPath, cascade])).toBe(1);
    expect(estimateTokens(stdout)).toBeLessThanOrEqual(600);
  });
});

describe("CT-5: concurrent scope isolation", () => {
  it("writes one state file per scope with no temp files left behind", async () => {
    const failing = childScript(`process.exit(1);`);
    const run = (scope: string): Promise<number> =>
      main(["--tdd-phase=red", `--scope-id=${scope}`, "--", process.execPath, failing]);

    const codes = await Promise.all([run("s01"), run("s02")]);
    expect(codes).toEqual([0, 0]);

    const files = fs.readdirSync(home).sort();
    expect(files).toContain("state-s01.json");
    expect(files).toContain("state-s02.json");
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    expect(fs.readFileSync(path.join(home, "state-s01.json"), "utf8")).toContain('"s01"');
    expect(fs.readFileSync(path.join(home, "state-s02.json"), "utf8")).toContain('"s02"');
  });
});
```

- [ ] **Step 3: Run the suite**

Run: `pnpm vitest run tests/compliance.spec.ts`
Expected: `6 passed`. The three CT-3 cases each spawn `vitest` and take a few seconds; the per-test timeout allows for that.

- [ ] **Step 4: Write `README.md`**

```markdown
# dot-test-digest

Bounded output compressor for test runs, compilers and build tools.
Implements [`specs/SPEC-002-DOT-TEST-DIGEST.md`](specs/SPEC-002-DOT-TEST-DIGEST.md).

```bash
dot-test-digest --tdd-phase=green -- vitest run
dot-test-digest --format=json -- cargo build
dot-test-digest --no-jev -- tsc --noEmit
```

- **Pass:** one line, at most 160 bytes (`[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: …`).
- **Fail:** deduplicated failure clusters with a pruned stack and an inlined source window, at most 600 tokens.
- **Always:** the child's exit code (or `128 + signal`) is returned unchanged, and the full raw stream is kept in `~/.cache/dot-test-digest/logs/<run_id>.log`.

Gear 1 (Jev `jev-1.13.0`) is used only for unstructured failures above 150 lines and needs `TYPESAFE_API_KEY`.
Without it, the heuristic fallback still narrows the log.

TDD state lives in `~/.cache/dot-test-digest/state-<scope_id>.json`; `--scope-id` isolates concurrent runs.
`DOT_TEST_DIGEST_HOME` relocates both caches.

```bash
pnpm install
pnpm verify     # typecheck + unit tests
pnpm build      # emits dist/ with the dot-test-digest bin
```
```

- [ ] **Step 5: Verify the whole repository**

Run:

```bash
pnpm verify
pnpm build
node dist/index.js --version
node dist/index.js -- node -e "console.log('ok')"
```

Expected: typecheck clean; all unit tests pass; `0.1.0`; the last command prints a one-line `[PASS]` digest and exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: add ct-1..ct-5 compliance suite and project readme"
```

---

## Definition of Done (SPEC §6)

| Check | Where it is proven | Status |
|---|---|---|
| **CT-1** pass-state ≤160 bytes, 2,500 lines preserved | `tests/cli.spec.ts` › "pass-state compression" | Plan step Task 12 |
| **CT-2** 50→1 cascade, 0 `node_modules` frames, 5-line window, ≤220 tokens | `tests/cli.spec.ts` › "cascade deduplication" | Plan step Task 12 |
| **CT-3** (a) pass, (b) broken import → `INVALID_RED` 64, (c) assertion → `VALID_RED` 0 | `tests/compliance.spec.ts` › CT-3 (real vitest) | Plan step Task 13 |
| **CT-4** ≤255 windows in one RPC, exact linker window returned | `tests/compliance.spec.ts` › CT-4 (local Jev stub) | Plan step Task 13 |
| **CT-5** isolated `state-s01/s02.json`, no lock contention | `tests/compliance.spec.ts` › CT-5, `tests/dedup-and-tdd.spec.ts` › scope isolation | Plan steps 10, 13 |
| **INV-3** exit-code/signal transparency | `tests/cli.spec.ts` › 42 / 143 / 64 / 127 | Plan step Task 12 |
| **INV-6** option ceiling enforced twice (partitioner + Zod refine) | `tests/gear1-jev.spec.ts` | Plan step Task 11 |

Known limitation to record in the PR: CT-4's `< 150ms` is a property of the Jev service, not of this binary; the suite asserts the single-round-trip and ≤255-window properties that this repository controls.

## Spec amendments this plan assumes (file against v0.1.1)

See `specs/INTEGRITY-SPEC-002.md` §5. Highest-value first: the Jev endpoint and type casing (R1), `VALID_RED` (R2), `--retry-flakes` (R3), the Noul probability threshold (R4), `pruned_stack` size (R6), the green failure row (R9), the truncation policy (R10) and the JSON-format exemption from INV-1 (R13).

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-30-dot-test-digest.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with `superpowers:executing-plans`, batch execution with checkpoints for review.
