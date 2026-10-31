import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE = join(ROOT, "node_modules", ".cache");
const PASSING_CHILD = ["node", "-e", "process.exit(0)"];

let build: string;
let work: string;

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true });
  build = mkdtempSync(join(CACHE, "bin-entry-"));
  writeFileSync(join(build, "package.json"), '{"type":"module"}');
  const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--outDir", build], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(tsc.status, tsc.stdout).toBe(0);
  work = mkdtempSync(join(tmpdir(), "dtd-bin-"));
}, 60_000);

afterAll(() => {
  rmSync(build, { recursive: true, force: true });
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
    const r = runBin(join(build, "index.js"));
    expect(r.stdout, r.stderr).toContain("INVALID_RED");
    expect(r.status).toBe(64);
  });

  it("runs when launched through a symlink, as npm link and global installs do", () => {
    const link = join(work, "dot-test-digest");
    symlinkSync(join(build, "index.js"), link);
    const r = runBin(link);
    expect(r.stdout, r.stderr).toContain("INVALID_RED");
    expect(r.status).toBe(64);
  });

  it("can be imported by a host whose argv[1] is not a file, without running or throwing", () => {
    const url = pathToFileURL(join(build, "index.js")).href;
    const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(url)}).then((m) => console.log(typeof m.main))`, "not-a-file"], {
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("function");
    expect(r.status).toBe(0);
  });
});
