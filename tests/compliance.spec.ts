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
    const failureText = [
      " FAIL  tests/a.spec.ts > case 1",
      "AssertionError: expected 1 to be 2",
      " \u276f tests/a.spec.ts:3:1",
      "      Tests  1 failed (1)",
    ].join("\n");
    const failing = childScript(
      `process.stdout.write(${JSON.stringify(failureText)}); process.exit(1);`,
    );
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
