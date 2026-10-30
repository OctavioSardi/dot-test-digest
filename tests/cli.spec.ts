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
