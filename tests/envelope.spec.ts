import os from "node:os";
import path from "node:path";
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

const LOG = path.join(os.homedir(), ".cache", "dot-test-digest", "logs", "run_8f2a.log");

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
