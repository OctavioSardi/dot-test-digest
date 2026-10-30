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
