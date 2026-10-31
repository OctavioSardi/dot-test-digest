import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD = join(ROOT, "node_modules", ".cache", "bin-entry-spec");
const PASSING_CHILD = ["node", "-e", "process.exit(0)"];

let work: string;

beforeAll(() => {
  mkdirSync(BUILD, { recursive: true });
  const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--outDir", BUILD], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(tsc.status, tsc.stdout).toBe(0);
  work = mkdtempSync(join(tmpdir(), "dtd-bin-"));
}, 60_000);

afterAll(() => {
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function runBin(path: string) {
  return spawnSync(process.execPath, [path, "--no-jev", "--tdd-phase=red", "--", ...PASSING_CHILD], {
    encoding: "utf8",
    env: { ...process.env, DOT_TEST_DIGEST_HOME: join(work, "home") },
  });
}

describe("bin entry (INV-3, INV-5)", () => {
  it("runs when launched directly", () => {
    const r = runBin(join(BUILD, "index.js"));
    expect(r.stdout).toContain("INVALID_RED");
    expect(r.status).toBe(64);
  });

  it("runs when launched through a symlink, as npm link and global installs do", () => {
    const link = join(work, "dot-test-digest");
    symlinkSync(join(BUILD, "index.js"), link);
    const r = runBin(link);
    expect(r.stdout).toContain("INVALID_RED");
    expect(r.status).toBe(64);
  });
});
