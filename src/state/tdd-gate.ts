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

/**
 * R14: a runner this binary has no grammar for (json/junit reporters, TAP variants)
 * still fails for a *behavioral* reason, which INV-5 says is a valid red.
 */
const BEHAVIORAL_EVIDENCE =
  /AssertionError|expected .* to (?:be|equal|match|contain|throw)|does not provide an export named|missing export|is not a function|Cannot read propert/;

export interface PhaseArgs {
  phase: TddPhase;
  childExitCode: number;
  failures: readonly RawFailure[];
  gear: ExecutionGear;
  previousState: RunState | null;
  failedTests: readonly string[];
  passed: number;
  /** Raw failure text kept for runners we could not parse (optional). */
  evidence?: string;
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
        if (BEHAVIORAL_EVIDENCE.test(args.evidence ?? "")) {
          return withDelta({ status: "VALID_RED", exitCode: 0, recordBaseline: true });
        }
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
