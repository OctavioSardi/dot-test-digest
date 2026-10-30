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
