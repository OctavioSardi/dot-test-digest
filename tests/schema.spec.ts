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
