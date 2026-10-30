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

  it("accepts an unparsed behavioral failure that left evidence in the log (R14)", () => {
    const decision = evaluatePhase(
      phaseArgs({
        phase: "red",
        childExitCode: 1,
        failures: [],
        evidence: '{"failureMessages":[["AssertionError: expected 99 to be 100"]]}',
      }),
    );
    expect(decision.status).toBe("VALID_RED");
    expect(decision.exitCode).toBe(0);
    expect(decision.recordBaseline).toBe(true);
  });

  it("still blocks a silent failure with no evidence", () => {
    const decision = evaluatePhase(
      phaseArgs({ phase: "red", childExitCode: 1, failures: [], evidence: "" }),
    );
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
