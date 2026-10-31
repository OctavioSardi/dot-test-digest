#!/usr/bin/env node
/**
 * Acceptance harness for dot-test-digest (SPEC-002 v0.1.1).
 *
 * Everything here is derived from the spec and from code paths that already
 * exist; it generates its own fixtures, runs the *built* binary, and records
 * every command, stream, assertion and observation.
 *
 * Design rules:
 *  - The harness never touches your real cache: DOT_TEST_DIGEST_HOME points at
 *    a throwaway directory under the system temp dir.
 *  - Every check is independent except where the spec itself is stateful
 *    (red -> green). Those dependencies are stated in the check title.
 *  - Assertions only cover what the spec promises. Things worth knowing but
 *    not promised (e.g. where the heuristic lands) are recorded as
 *    observations, never as failures.
 *  - The Jev check is opt-in (TYPESAFE_API_KEY) and records the request through
 *    a local proxy, so the wire contract is verified without trusting stdout.
 *
 * Usage:
 *   node scripts/acceptance/run-acceptance.mjs
 *   TYPESAFE_API_KEY=... node scripts/acceptance/run-acceptance.mjs
 *
 * Exit code: 0 when nothing failed, 1 when at least one check failed,
 * 2 when the harness could not start (missing dist/ or node_modules/).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const TOOL = path.join(REPO, "dist", "index.js");
const VITEST = path.join(REPO, "node_modules", "vitest", "vitest.mjs");
/** Mirrors JEV_TIMEOUT_MS in src/gears/jev-client.ts. */
const JEV_CLIENT_TIMEOUT_MS = 1200;

const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const SPEC = path.join(REPO, "specs", "SPEC-002-DOT-TEST-DIGEST.md");
const SPEC_VERSION = /^\|\s*\*\*Version\*\*\s*\|\s*`([^`]+)`/m.exec(
  fs.existsSync(SPEC) ? fs.readFileSync(SPEC, "utf8") : "",
)?.[1] ?? "unknown";

const STAMP = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .replace("Z", "");
const OUT = path.join(REPO, ".acceptance", `run-${STAMP}`);
const ART = path.join(OUT, "artifacts");
const FIX = path.join(OUT, "fixtures");
// Deliberately short: the pass line is capped at 160 bytes, and a deep cache
// path would push the log pointer out of the line (that is a product concern,
// not something this harness should trip over).
const CACHE = path.join(os.tmpdir(), `dtd-acc-${Date.now().toString(36)}`);

const transcript = [];
const checks = [];
const preflight = [];

function tlog(line = "") {
  transcript.push(line);
}

function show(line = "") {
  transcript.push(line);
  console.log(line);
}

function brief(value, limit = 240) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function countLines(text) {
  if (text === "") return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

function countMatches(text, regex) {
  const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  return [...text.matchAll(global)].length;
}

/** The pass/fail line ends with `| log: <path>`; `~` means the real home dir. */
function logPathFrom(stdoutText) {
  const firstLine = stdoutText.split("\n")[0] ?? "";
  const marker = firstLine.lastIndexOf("log: ");
  if (marker === -1) return null;
  const raw = firstLine.slice(marker + "log: ".length).trim();
  if (raw === "" || raw.endsWith("...")) return null;
  return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
}

async function readFileSafe(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function baseEnv(extra = {}) {
  const env = { ...process.env };
  // Never inherit a key or URL from the caller unless a check asks for it.
  delete env.TYPESAFE_API_KEY;
  delete env.TYPESAFE_API_URL;
  env.DOT_TEST_DIGEST_HOME = CACHE;
  return { ...env, ...extra };
}

function runProcess(command, args, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const stdout = [];
    const stderr = [];
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        code: payload.code,
        signal: payload.signal,
        spawnError: payload.spawnError ?? null,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.code ?? "ERROR" }));
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

function runTool(args, options = {}) {
  return runProcess(process.execPath, [TOOL, ...args], {
    cwd: options.cwd ?? REPO,
    env: baseEnv(options.env),
    timeoutMs: options.timeoutMs,
  });
}

function makeAssertions(record) {
  const add = (ok, label, detail = "") => {
    record.assertions.push({ ok: Boolean(ok), label, detail: String(detail) });
  };
  return {
    ok: (condition, label, detail = "") => add(condition, label, detail),
    eq: (actual, expected, label) =>
      add(Object.is(actual, expected), label, `expected ${brief(expected)}, got ${brief(actual)}`),
    ne: (actual, excluded, label) =>
      add(!Object.is(actual, excluded), label, `value was ${brief(actual)}`),
    ge: (actual, min, label) =>
      add(typeof actual === "number" && actual >= min, label, `expected >= ${min}, got ${brief(actual)}`),
    le: (actual, max, label) =>
      add(typeof actual === "number" && actual <= max, label, `expected <= ${max}, got ${brief(actual)}`),
    includes: (haystack, needle, label) =>
      add(typeof haystack === "string" && haystack.includes(needle), label, `missing ${brief(needle)} in ${brief(haystack, 300)}`),
    excludes: (haystack, needle, label) =>
      add(typeof haystack === "string" && !haystack.includes(needle), label, `unexpected ${brief(needle)} in ${brief(haystack, 300)}`),
    match: (value, regex, label) =>
      add(typeof value === "string" && regex.test(value), label, `no match for ${regex} in ${brief(value, 300)}`),
  };
}

async function check(id, title, body) {
  const record = {
    id,
    title,
    status: "FAIL",
    skipReason: null,
    assertions: [],
    observations: [],
    commands: [],
    streams: [],
    durationMs: 0,
  };
  const startedAt = Date.now();
  const t = makeAssertions(record);

  const capture = (result, args) => {
    record.commands.push({
      args,
      exit: result.code,
      signal: result.signal,
      spawnError: result.spawnError,
      timedOut: result.timedOut,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      durationMs: result.durationMs,
    });
    record.streams.push({
      args,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    });
    return result;
  };

  const ctx = {
    tool: (args, options) => runTool(args, options).then((result) => capture(result, args.join(" "))),
    run: (command, args, options) =>
      runProcess(command, args, options).then((result) => capture(result, [command, ...args].join(" "))),
    observe: (label, value) => record.observations.push({ label, value: String(value) }),
    fixture: (rel) => path.join(FIX, rel),
    cache: () => CACHE,
  };

  tlog(`\n=== ${id} ${title}`);

  try {
    const outcome = await body(t, ctx);
    if (outcome && outcome.skip) {
      record.status = "SKIP";
      record.skipReason = outcome.skip;
    } else {
      record.status =
        record.assertions.length > 0 && record.assertions.every((assertion) => assertion.ok)
          ? "PASS"
          : "FAIL";
    }
  } catch (error) {
    record.status = "FAIL";
    record.assertions.push({
      ok: false,
      label: "harness error",
      detail: error && error.stack ? error.stack : String(error),
    });
  }

  record.durationMs = Date.now() - startedAt;

  if (record.streams.length > 0) {
    const bodyText = record.streams
      .map(
        (stream, index) =>
          `### command ${index + 1}: ${stream.args}\n--- stdout ---\n${stream.stdout}\n--- stderr ---\n${stream.stderr}`,
      )
      .join("\n\n");
    const trimmed =
      bodyText.length > 2_000_000
        ? `${bodyText.slice(0, 2_000_000)}\n\n[artifact truncated at 2 MB]`
        : bodyText;
    await fsp.writeFile(path.join(ART, `${id}.txt`), trimmed, "utf8");
  }

  show(`${record.status.padEnd(4)}  ${id}  ${title}  (${record.durationMs}ms)`);
  if (record.status === "FAIL") {
    for (const assertion of record.assertions.filter((item) => !item.ok)) {
      show(`      x ${assertion.label} -- ${assertion.detail}`);
    }
  }
  if (record.status === "SKIP" && record.skipReason) show(`      - ${record.skipReason}`);
  for (const observation of record.observations) {
    show(`      . ${observation.label}: ${observation.value}`);
  }

  checks.push(record);
  return record;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, "utf8");
  }
}

function vitestConfig() {
  return [
    'import { defineConfig } from "vitest/config";',
    "",
    "export default defineConfig({",
    "  test: {",
    '    include: ["**/*.spec.ts"],',
    '    exclude: ["node_modules/**"],',
    '    reporters: ["default"],',
    "    silent: false,",
    '    pool: "forks",',
    "  },",
    "});",
    "",
  ].join("\n");
}

/** 50 tests x 50 console.log lines = 2,500+ lines of passing noise. */
function passSpec() {
  const lines = [
    'import { describe, expect, it } from "vitest";',
    "",
    'describe("ACCEPTANCE pass fixture", () => {',
  ];
  for (let test = 0; test < 50; test += 1) {
    lines.push(`  it("case ${String(test).padStart(2, "0")}", () => {`);
    for (let line = 0; line < 50; line += 1) {
      lines.push(
        `    console.log("ACCEPTANCE-PASS ${test}-${line} " + "x".repeat(40));`,
      );
    }
    lines.push("    expect(true).toBe(true);");
    lines.push("  });");
  }
  lines.push("});");
  return `${lines.join("\n")}\n`;
}

/**
 * The throw site must be a repository frame so the runner prints it within
 * V8's 10-frame stack limit (CT-2, SPEC-002 v0.1.2). The fixture must not
 * change the child's runtime behaviour (no `--stack-trace-limit`): whatever
 * the runner prints is what the adapter has to parse.
 */
function cascadeHelper() {
  return [
    "/**",
    " * Parses a dotted token; the cascade fixture calls it with a number.",
    " */",
    "export function parseToken(token: string): string {",
    '  const parts = token.split(".");',
    '  return parts.join(".").toUpperCase();',
    "}",
    "",
  ].join("\n");
}

function cascadeSpec(fileIndex) {
  const tests = [];
  for (let test = 0; test < 5; test += 1) {
    tests.push(
      `  it("case ${test}", () => { expect(parseToken(42 as unknown as string)).toBe("42"); });`,
    );
  }
  return [
    'import { describe, expect, it } from "vitest";',
    'import { parseToken } from "./src/helper";',
    "",
    `describe("ACCEPTANCE cascade file ${String(fileIndex).padStart(2, "0")}", () => {`,
    ...tests,
    "});",
    "",
  ].join("\n");
}

/** 3,000-line unstructured build whose real failure sits ~400 lines above the tail. */
function unstructuredBuild() {
  return [
    "const lines = [];",
    "for (let index = 1; index <= 3000; index += 1) {",
    "  lines.push(`[${index}/3000] compiling translation unit ${index} ... ok`);",
    "}",
    'lines[2598] = "ld: undefined reference to `SSL_new\\x27";',
    'lines[2599] = "collect2: error: ld returned 1 exit status";',
    'process.stdout.write(`${lines.join("\\n")}\\n`);',
    "process.exit(2);",
    "",
  ].join("\n");
}

async function buildFixtures() {
  await writeTree(path.join(FIX, "pass"), {
    "vitest.config.ts": vitestConfig(),
    "pass.spec.ts": passSpec(),
  });

  const cascade = {
    "vitest.config.ts": vitestConfig(),
    "src/helper.ts": cascadeHelper(),
  };
  for (let file = 1; file <= 10; file += 1) {
    cascade[`file-${String(file).padStart(2, "0")}.spec.ts`] = cascadeSpec(file);
  }
  await writeTree(path.join(FIX, "cascade"), cascade);

  await writeTree(path.join(FIX, "red"), {
    "vitest.config.ts": vitestConfig(),
    "src/cart.ts": [
      "export interface Cart {",
      "  total: () => number;",
      "}",
      "",
      "export function makeCart(): Cart {",
      "  return { total: () => 99 };",
      "}",
      "",
    ].join("\n"),
    "passing.spec.ts": [
      'import { expect, it } from "vitest";',
      "",
      'it("ACCEPTANCE passing case", () => {',
      "  expect(1 + 1).toBe(2);",
      "});",
      "",
    ].join("\n"),
    "broken-import.spec.ts": [
      'import { expect, it } from "vitest";',
      'import { makeCart } from "./src/cartt";',
      "",
      'it("ACCEPTANCE broken import", () => {',
      "  expect(makeCart().total()).toBe(100);",
      "});",
      "",
    ].join("\n"),
    "failing.spec.ts": [
      'import { expect, it } from "vitest";',
      'import { makeCart } from "./src/cart";',
      "",
      'it("ACCEPTANCE red case", () => {',
      "  expect(makeCart().total()).toBe(100);",
      "});",
      "",
    ].join("\n"),
  });

  // Two copies so the concurrent CT-5 runs never share a Vite cache dir.
  for (const copy of ["isolate-a", "isolate-b"]) {
    await writeTree(path.join(FIX, copy), {
      "vitest.config.ts": vitestConfig(),
      "always-fails.spec.ts": [
        'import { expect, it } from "vitest";',
        "",
        'it("ACCEPTANCE isolation case", () => {',
        "  expect(1).toBe(2);",
        "});",
        "",
      ].join("\n"),
    });
  }

  await writeTree(path.join(FIX, "node-test"), {
    "cart.mjs": "export function makeCart() { return { total: () => 99 }; }\n",
    "cart.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { makeCart, missingThing } from "./cart.mjs";',
      "",
      'test("ACCEPTANCE totals", () => {',
      "  assert.equal(makeCart().total(), 100);",
      "});",
      "",
    ].join("\n"),
  });

  await writeTree(path.join(FIX, "unstructured"), {
    "build.mjs": unstructuredBuild(),
  });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function runChecks() {
  const passDir = path.join(FIX, "pass");
  const cascadeDir = path.join(FIX, "cascade");
  const redDir = path.join(FIX, "red");
  const isolateA = path.join(FIX, "isolate-a");
  const isolateB = path.join(FIX, "isolate-b");
  const nodeTestDir = path.join(FIX, "node-test");
  const unstructuredDir = path.join(FIX, "unstructured");

  await check("C01", "binary answers --version and --help", async (t, ctx) => {
    const version = await ctx.tool(["--version"]);
    t.eq(version.code, 0, "--version exits 0");
    t.eq(version.stdout.toString("utf8").trim(), PKG.version, "prints package.json version");

    const help = await ctx.tool(["--help"]);
    const helpText = help.stdout.toString("utf8");
    t.eq(help.code, 0, "--help exits 0");
    t.includes(helpText, "Usage: dot-test-digest", "--help documents the invocation shape");
    t.includes(helpText, "--tdd-phase", "--help lists --tdd-phase");
    t.includes(helpText, "TYPESAFE_API_KEY", "--help documents the environment");
  });

  await check("C02", "usage errors exit 64 with a diagnostic on stderr", async (t, ctx) => {
    const unknown = await ctx.tool(["--definitely-not-a-flag", "--", "true"]);
    t.eq(unknown.code, 64, "unknown flag exits 64");
    t.eq(unknown.stdout.length, 0, "unknown flag writes nothing to stdout");
    t.includes(unknown.stderr.toString("utf8"), "unknown flag", "diagnostic names the offending flag");

    const missingDelimiter = await ctx.tool(["vitest", "run"]);
    t.eq(missingDelimiter.code, 64, "missing -- delimiter exits 64");
    t.includes(
      missingDelimiter.stderr.toString("utf8"),
      "missing -- delimiter",
      "diagnostic names the missing delimiter",
    );

    const badBoolean = await ctx.tool(["--no-jev=maybe", "--", "true"]);
    t.eq(badBoolean.code, 64, "--no-jev=maybe exits 64");
    t.includes(badBoolean.stderr.toString("utf8"), "true or false", "diagnostic explains the boolean rule");

    const badRange = await ctx.tool(["--max-clusters=99", "--", "true"]);
    t.eq(badRange.code, 64, "out-of-range --max-clusters exits 64");
    t.includes(badRange.stderr.toString("utf8"), "between 1 and 15", "diagnostic names the valid range");
  });

  await check("C03", "CT-1: 2,500+ lines of passing output collapse to <=160 bytes", async (t, ctx) => {
    const baseline = await ctx.run(process.execPath, [VITEST, "run"], {
      cwd: passDir,
      timeoutMs: 180_000,
    });
    const baselineText = `${baseline.stdout.toString("utf8")}${baseline.stderr.toString("utf8")}`;
    const baselineLines = countLines(baselineText);
    t.eq(baseline.code, 0, "fixture passes without the tool");
    t.ge(baselineLines, 2500, "fixture emits >=2,500 lines before digesting (fixture sanity)");
    t.includes(baselineText, "ACCEPTANCE-PASS 0-0", "fixture logs the first marker");

    const result = await ctx.tool(["--", process.execPath, VITEST, "run"], {
      cwd: passDir,
      timeoutMs: 180_000,
    });
    const stdoutText = result.stdout.toString("utf8");
    t.eq(result.code, 0, "child exit code 0 is preserved");
    t.le(result.stdout.length, 160, "stdout is <=160 bytes including the trailing newline");
    t.eq(countLines(stdoutText), 1, "stdout is exactly one line");
    t.match(stdoutText, /^\[PASS\] \d+ passed, 0 failed /, "line reports PASS with zero failures");

    const logPath = logPathFrom(stdoutText);
    t.ok(logPath !== null, "pass line still carries a resolvable log pointer");
    const logText = logPath === null ? "" : await readFileSafe(logPath);
    t.ge(countLines(logText), baselineLines - 5, "raw log keeps every line the child wrote");
    t.includes(logText, "ACCEPTANCE-PASS 0-0", "raw log preserves the first console.log");
    t.includes(logText, "ACCEPTANCE-PASS 49-49", "raw log preserves the last console.log");

    ctx.observe(
      "compression",
      `${baselineLines} lines / ${Buffer.byteLength(baselineText)} bytes -> ${result.stdout.length} bytes on stdout`,
    );
  });

  await check("C04", "CT-2: 50 failures in 10 files collapse to one cluster", async (t, ctx) => {
    const result = await ctx.tool(["--", process.execPath, VITEST, "run"], {
      cwd: cascadeDir,
      timeoutMs: 180_000,
    });
    const text = result.stdout.toString("utf8");
    t.eq(result.code, 1, "child exit code 1 is preserved");
    t.le(result.stdout.length, 2400, "stdout is <=2,400 bytes (INV-2)");
    t.match(text, /^\[FAIL\] 50 failed, 0 passed /, "header reports 50 failed");
    t.match(text, /\| 1 cluster \|/, "header reports exactly one cluster");
    t.match(text, /\bx50\b/, "affected_count is 50");
    t.eq(countMatches(text, /^c_[0-9a-f]{8} /m), 1, "exactly one cluster block is emitted");
    // INV-4 allows exactly one external boundary frame, so 0 or 1 is correct
    // and 35 (the fixture's stack depth) is not.
    t.le(countMatches(text, /node_modules/g), 1, "at most one external boundary frame survives");
    t.match(text, /raw: L\d+-L\d+/, "cluster carries a raw log line range");
  });

  await check("C05", "CT-2 in JSON: cluster structure, INV-4 pruning and raw pointer", async (t, ctx) => {
    const result = await ctx.tool(["--format=json", "--", process.execPath, VITEST, "run"], {
      cwd: cascadeDir,
      timeoutMs: 180_000,
    });
    t.eq(result.code, 1, "child exit code 1 is preserved");
    let envelope;
    try {
      envelope = JSON.parse(result.stdout.toString("utf8"));
    } catch (error) {
      t.ok(false, "stdout is a complete JSON document", String(error));
      return;
    }
    t.eq(envelope.status, "FAIL", "status is FAIL");
    t.eq(envelope.tdd_phase, "none", "tdd_phase is none");
    t.eq(envelope.execution_gear, "GEAR_0_GRAMMAR", "a grammar adapter handled the run");
    t.eq(envelope.exit_code, 1, "envelope records the child exit code");
    t.eq(envelope.summary.failed, 50, "summary.failed is 50");
    t.eq(envelope.summary.total_clusters, 1, "summary.total_clusters is 1");

    const cluster = Array.isArray(envelope.clusters) ? envelope.clusters[0] : null;
    t.ok(cluster !== null, "one cluster is present");
    if (cluster === null) return;
    t.eq(cluster.affected_count, 50, "affected_count is 50");
    t.le(cluster.pruned_stack.length, 6, "pruned_stack has at most 6 entries (INV-4)");
    const external = cluster.pruned_stack.filter((frame) => frame.includes("node_modules"));
    t.le(external.length, 1, "at most one external boundary frame survives pruning");
    const repoFrames = cluster.pruned_stack.filter((frame) => !frame.includes("node_modules"));
    t.le(repoFrames.length, 5, "at most five repository frames survive pruning");
    t.ok(
      repoFrames.some((frame) => frame.includes("src/helper.ts")),
      "the failing repository frame is retained",
      brief(cluster.pruned_stack),
    );
    t.match(cluster.raw_log_lines, /^L\d+-L\d+$/, "raw_log_lines is a valid range");
    t.ok(fs.existsSync(envelope.raw_log_path), "raw_log_path points at a real file");
    t.ge(cluster.signal_window.split("\n").length, 3, "signal_window contains context lines");
  });

  await check("C06", "SignalWindow marks the failing line and matches the file on disk", async (t, ctx) => {
    const result = await ctx.tool(["--format=json", "--", process.execPath, VITEST, "run"], {
      cwd: cascadeDir,
      timeoutMs: 180_000,
    });
    let envelope;
    try {
      envelope = JSON.parse(result.stdout.toString("utf8"));
    } catch (error) {
      t.ok(false, "stdout is a complete JSON document", String(error));
      return;
    }
    const cluster = Array.isArray(envelope.clusters) ? envelope.clusters[0] : null;
    t.ok(cluster !== null, "one cluster is present");
    if (cluster === null) return;

    const parsed = /^(.+):(\d+):(\d+)$/.exec(cluster.top_frame);
    t.ok(parsed !== null, "top_frame is repo-relative file:line:col", brief(cluster.top_frame));
    if (parsed === null) return;

    const [, relativeFile, lineText] = parsed;
    const lineNumber = Number(lineText);
    const sourceFile = path.join(cascadeDir, relativeFile);
    const source = (await readFileSafe(sourceFile)).split("\n");
    const expected = (source[lineNumber - 1] ?? "").trim();
    t.ok(fs.existsSync(sourceFile), "top_frame names a file that exists");
    t.ok(expected.length > 0, "top_frame points at a non-empty line");

    const window = cluster.signal_window;
    const marked = window
      .split("\n")
      .find((row) => new RegExp(`^\\s*${lineNumber} > `).test(row));
    t.ok(marked !== undefined, `signal_window marks line ${lineNumber} with '>'`, brief(window));
    if (marked !== undefined) {
      const content = marked.replace(/^\s*\d+ > /, "").trim();
      t.eq(content, expected, "the marked line matches the source file byte for byte");
    }
    t.match(window, /\d+ \| /, "signal_window also carries neighbouring lines");
  });

  await check("C07", "INV-3: a child exit code of 42 is preserved", async (t, ctx) => {
    const result = await ctx.tool(["--", process.execPath, "-e", "process.exit(42)"]);
    t.eq(result.code, 42, "parent exits 42");
    t.le(result.stdout.length, 2400, "stdout stays within the fail ceiling");
    t.match(result.stdout.toString("utf8"), /log: /, "a log pointer is still emitted");
  });

  await check("C08", "INV-3: SIGTERM maps to 143 and is recorded", async (t, ctx) => {
    const result = await ctx.tool([
      "--format=json",
      "--",
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    t.eq(result.code, 143, "parent exits 128 + 15");
    let envelope;
    try {
      envelope = JSON.parse(result.stdout.toString("utf8"));
    } catch (error) {
      t.ok(false, "stdout is a complete JSON document", String(error));
      return;
    }
    t.eq(envelope.exit_code, 143, "envelope records 143");
    t.eq(envelope.signal, "SIGTERM", "envelope records the signal name");
  });

  await check("C09", "INV-3: a missing command exits 127", async (t, ctx) => {
    const result = await ctx.tool(["--", "definitely-not-a-real-command-acceptance"]);
    t.eq(result.code, 127, "parent exits 127");
    t.includes(result.stderr.toString("utf8"), "dot-test-digest:", "diagnostic is prefixed");
  });

  await check("C10", "INV-5: a passing file is blocked in red phase (exit 64)", async (t, ctx) => {
    const result = await ctx.tool(
      ["--tdd-phase=red", "--scope-id=acc-passing", "--", process.execPath, VITEST, "run", "passing.spec.ts"],
      { cwd: redDir, timeoutMs: 180_000 },
    );
    t.eq(result.code, 64, "parent exits 64");
    t.match(result.stdout.toString("utf8"), /^\[INVALID_RED \| RED\]/, "status is INVALID_RED");
    t.includes(
      result.stderr.toString("utf8"),
      "New test passed before implementation",
      "diagnostic explains the block",
    );
  });

  await check("C11", "INV-5: a broken import is blocked in red phase (exit 64)", async (t, ctx) => {
    const result = await ctx.tool(
      [
        "--tdd-phase=red",
        "--scope-id=acc-broken",
        "--",
        process.execPath,
        VITEST,
        "run",
        "broken-import.spec.ts",
      ],
      { cwd: redDir, timeoutMs: 180_000 },
    );
    t.eq(result.code, 64, "parent exits 64");
    t.match(result.stdout.toString("utf8"), /^\[INVALID_RED \| RED\]/, "status is INVALID_RED");
    t.includes(
      result.stderr.toString("utf8"),
      "syntax or unresolved module import",
      "diagnostic distinguishes syntax from behavior",
    );
  });

  await check("C12", "INV-5: an assertion failure is a valid red (exit 0, baseline written)", async (t, ctx) => {
    const result = await ctx.tool(
      ["--tdd-phase=red", "--scope-id=acc-red", "--", process.execPath, VITEST, "run", "failing.spec.ts"],
      { cwd: redDir, timeoutMs: 180_000 },
    );
    const text = result.stdout.toString("utf8");
    t.eq(result.code, 0, "parent exits 0");
    t.match(text, /^\[VALID_RED \| RED\]/, "status is VALID_RED");
    t.le(result.stdout.length, 160, "valid red is a one-liner within 160 bytes");

    const statePath = path.join(CACHE, "state-acc-red.json");
    t.ok(fs.existsSync(statePath), "state file exists for the scope");
    const stateText = await readFileSafe(statePath);
    let state = null;
    try {
      state = JSON.parse(stateText);
    } catch {
      t.ok(false, "state file is valid JSON", brief(stateText));
    }
    if (state !== null) {
      t.eq(state.phase, "red", "state records the phase");
      t.ge(state.baseline.length, 1, "baseline records the failing test");
      t.ok(
        state.baseline.some((name) => String(name).includes("ACCEPTANCE red case")),
        "baseline names the failing test case",
        brief(state.baseline),
      );
    }
  });

  await check("C13", "INV-5: a missing exported symbol is a valid red (exit 0)", async (t, ctx) => {
    const result = await ctx.tool(
      [
        "--tdd-phase=red",
        "--scope-id=acc-missing-export",
        "--",
        process.execPath,
        "--test",
        "cart.test.mjs",
      ],
      { cwd: nodeTestDir, timeoutMs: 180_000 },
    );
    t.eq(result.code, 0, "parent exits 0");
    t.match(result.stdout.toString("utf8"), /^\[VALID_RED \| RED\]/, "status is VALID_RED");

    const state = JSON.parse(await readFileSafe(path.join(CACHE, "state-acc-missing-export.json")) || "null");
    t.ok(state !== null, "state file exists for the scope");
    if (state !== null) {
      t.ge(state.baseline.length, 1, "baseline records the failing test");
    }
  });

  await check("C14", "green after red reports PASS with a +1 delta (depends on C12)", async (t, ctx) => {
    // Make the red test pass: the same scope must now show newly-passing work.
    await writeTree(redDir, {
      "src/cart.ts": [
        "export interface Cart {",
        "  total: () => number;",
        "}",
        "",
        "export function makeCart(): Cart {",
        "  return { total: () => 100 };",
        "}",
        "",
      ].join("\n"),
    });

    const result = await ctx.tool(
      ["--tdd-phase=green", "--scope-id=acc-red", "--", process.execPath, VITEST, "run", "failing.spec.ts"],
      { cwd: redDir, timeoutMs: 180_000 },
    );
    const text = result.stdout.toString("utf8");
    t.eq(result.code, 0, "parent exits 0");
    t.match(text, /^\[PASS \| GREEN\] 1 passed, 0 failed/, "status is PASS | GREEN with one passing test");
    t.includes(text, "delta: +1 newly passing", "delta counts the baseline test as newly passing");
    t.includes(text, "0 regressions", "delta reports no regressions");

    const state = JSON.parse(await readFileSafe(path.join(CACHE, "state-acc-red.json")) || "null");
    t.ok(state !== null, "state file still exists");
    if (state !== null) {
      t.eq(state.last_run?.status, "PASS", "state records the green run");
    }
  });

  await check("C15", "CT-5: two concurrent scopes write isolated state with no temp residue", async (t, ctx) => {
    // The scope value is a standalone token so the placeholder can be replaced;
    // `--scope-id=__SCOPE__` would not match the `part === "__SCOPE__"` test.
    const command = ["--tdd-phase=red", "--scope-id", "__SCOPE__", "--", process.execPath, VITEST, "run"];
    const [first, second] = await Promise.all([
      ctx.tool(command.map((part) => (part === "__SCOPE__" ? "s01" : part)), {
        cwd: isolateA,
        timeoutMs: 180_000,
      }),
      ctx.tool(command.map((part) => (part === "__SCOPE__" ? "s02" : part)), {
        cwd: isolateB,
        timeoutMs: 180_000,
      }),
    ]);
    t.eq(first.code, 0, "scope s01 is a valid red");
    t.eq(second.code, 0, "scope s02 is a valid red");
    t.match(first.stdout.toString("utf8"), /^\[VALID_RED \| RED\]/, "s01 reports VALID_RED");
    t.match(second.stdout.toString("utf8"), /^\[VALID_RED \| RED\]/, "s02 reports VALID_RED");

    const stateA = path.join(CACHE, "state-s01.json");
    const stateB = path.join(CACHE, "state-s02.json");
    t.ok(fs.existsSync(stateA), "state-s01.json exists");
    t.ok(fs.existsSync(stateB), "state-s02.json exists");

    const parsedA = JSON.parse((await readFileSafe(stateA)) || "null");
    const parsedB = JSON.parse((await readFileSafe(stateB)) || "null");
    t.eq(parsedA?.scope_id, "s01", "s01 state is scoped to s01");
    t.eq(parsedB?.scope_id, "s02", "s02 state is scoped to s02");

    const entries = await fsp.readdir(CACHE).catch(() => []);
    const tempFiles = entries.filter((name) => name.endsWith(".tmp"));
    t.eq(tempFiles.length, 0, "no .tmp residue is left behind", brief(tempFiles));
  });

  await check("C16", "unstructured 3,000-line build: BUILD_ERROR, bounded, raw pointer", async (t, ctx) => {
    const compact = await ctx.tool(["--no-jev", "--", process.execPath, "build.mjs"], {
      cwd: unstructuredDir,
      timeoutMs: 180_000,
    });
    const compactText = compact.stdout.toString("utf8");
    t.eq(compact.code, 2, "child exit code 2 is preserved");
    t.le(compact.stdout.length, 2400, "stdout is <=2,400 bytes (INV-2)");
    t.match(compactText, /^\[BUILD_ERROR\]/, "status is BUILD_ERROR (no grammar cluster)");
    t.match(compactText, /raw: L\d+-L\d+/, "cluster points into the raw log");

    const json = await ctx.tool(["--no-jev", "--format=json", "--", process.execPath, "build.mjs"], {
      cwd: unstructuredDir,
      timeoutMs: 180_000,
    });
    t.eq(json.code, 2, "json run also preserves exit code 2");
    let envelope;
    try {
      envelope = JSON.parse(json.stdout.toString("utf8"));
    } catch (error) {
      t.ok(false, "json run emits a complete document", String(error));
      return;
    }
    t.eq(envelope.status, "BUILD_ERROR", "json status is BUILD_ERROR");
    t.eq(
      envelope.execution_gear,
      "GEAR_0_HEURISTIC_FALLBACK",
      "--no-jev falls back to the heuristic",
    );
    t.le(envelope.summary.total_clusters, 5, "cluster count respects max_clusters");
    const cluster = Array.isArray(envelope.clusters) ? envelope.clusters[0] : null;
    t.ok(cluster !== null, "a cluster is produced");
    if (cluster !== null) {
      t.match(cluster.raw_log_lines, /^L\d+-L\d+$/, "raw_log_lines is a valid range");
      t.eq(cluster.error_kind, "UNSTRUCTURED_BUILD_ERROR", "error_kind marks the unstructured path");
    }
    ctx.observe(
      "root-cause text surfaced",
      compactText.includes("SSL_new") ? "yes (linker line is in the digest)" : "no (digest points at the log instead)",
    );
    ctx.observe(
      "window range",
      cluster === null ? "n/a" : `${cluster.raw_log_lines} of 3000 lines`,
    );
  });

  await check("C17", "self-host: the tool digests its own 141-test suite", async (t, ctx) => {
    const result = await ctx.tool(["--", process.execPath, VITEST, "run"], { timeoutMs: 300_000 });
    const text = result.stdout.toString("utf8");
    t.eq(result.code, 0, "own suite passes through the tool");
    t.le(result.stdout.length, 160, "pass line is <=160 bytes");
    t.match(text, /^\[PASS\] \d+ passed, 0 failed/, "reports PASS with zero failures");
    const passed = Number(/^\[PASS\] (\d+) passed/.exec(text)?.[1] ?? "0");
    t.ge(passed, 100, "digested at least 100 tests");
    ctx.observe("tests digested", `${passed}`);
  });

  await check("C18", "Gear 1 live wire contract (opt-in: TYPESAFE_API_KEY)", async (t, ctx) => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      return { skip: "TYPESAFE_API_KEY is not set; the Jev path is not exercised" };
    }

    const records = [];
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        records.push({
          method: request.method,
          url: request.url,
          body,
          hasAuthorization: Boolean(request.headers.authorization),
        });
        const entry = records[records.length - 1];
        const controller = new AbortController();
        const guard = setTimeout(() => controller.abort(), 15_000);
        const startedForward = Date.now();
        try {
          const headers = { ...request.headers };
          delete headers.host;
          delete headers["content-length"];
          const upstream = await fetch(`https://api.typesafe.ai${request.url}`, {
            method: request.method,
            headers,
            body,
            signal: controller.signal,
          });
          const payload = Buffer.from(await upstream.arrayBuffer());
          response.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          response.end(payload);
          entry.upstreamStatus = upstream.status;
          entry.upstreamLatencyMs = Date.now() - startedForward;
        } catch (error) {
          entry.upstreamStatus = 0;
          entry.upstreamError = String(error);
          entry.upstreamLatencyMs = Date.now() - startedForward;
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "proxy failed" }));
        } finally {
          clearTimeout(guard);
        }
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    let result;
    try {
      result = await ctx.tool(["--format=json", "--", process.execPath, "build.mjs"], {
        cwd: unstructuredDir,
        timeoutMs: 60_000,
        env: {
          TYPESAFE_API_KEY: apiKey,
          TYPESAFE_API_URL: `http://127.0.0.1:${port}`,
        },
      });
    } finally {
      await new Promise((resolve) => {
        // A still-open upstream socket must not keep the harness alive.
        server.closeAllConnections?.();
        server.close(resolve);
      });
    }

    t.eq(records.length, 1, "exactly one RPC call is made");
    t.eq(result.code, 2, "child exit code 2 is preserved");
    const record = records[0];
    if (record === undefined) return;

    t.eq(record.method, "POST", "request method is POST");
    t.eq(record.url, "/v1/systemone", "request targets /v1/systemone");
    t.ok(record.hasAuthorization, "request carries an Authorization header");

    let payload;
    try {
      payload = JSON.parse(record.body);
    } catch (error) {
      t.ok(false, "request body is JSON", String(error));
      return;
    }
    t.eq(payload.model, "jev-1.13.0", "model is jev-1.13.0");
    const questionIds = Object.keys(payload.questions ?? {});
    t.eq(questionIds.length, 3, "three questions are bundled");
    t.ok(questionIds.includes("root_cause_window"), "root_cause_window is asked");
    t.ok(questionIds.includes("error_category"), "error_category is asked");
    t.ok(questionIds.includes("is_transient_flake"), "is_transient_flake is asked");

    const questions = payload.questions ?? {};
    const lowercase = Object.values(questions).every(
      (question) => typeof question.type === "string" && question.type === question.type.toLowerCase(),
    );
    t.ok(lowercase, "every question type is lowercase", brief(Object.values(questions).map((q) => q.type)));
    t.ok(
      questions.root_cause_window?.type === "choice",
      "root_cause_window is a choice question",
    );
    t.ok(
      questions.is_transient_flake?.type === "noul",
      "is_transient_flake is a noul question",
    );
    const criteriaCount = Object.keys(questions.root_cause_window?.criteria ?? {}).length;
    t.ge(criteriaCount, 1, "root_cause_window has candidate criteria");
    t.le(criteriaCount, 255, "candidate options stay within 255 (INV-6)");
    t.eq(payload.state?.exit_code, 2, "state carries the child exit code");

    let envelope = null;
    try {
      envelope = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      t.ok(false, "stdout is a complete document");
    }
    const upstreamStatus = record.upstreamStatus ?? 0;
    const latency = record.upstreamLatencyMs ?? Number.POSITIVE_INFINITY;
    ctx.observe("upstream", `HTTP ${upstreamStatus} in ${record.upstreamLatencyMs ?? "?"}ms`);
    ctx.observe("candidate windows", `${criteriaCount}`);
    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      return {
        skip: `Jev upstream returned HTTP ${upstreamStatus}; the request shape was verified but no answer was`,
      };
    }
    if (latency > JEV_CLIENT_TIMEOUT_MS) {
      // The answer exists but arrived after the client's 1.2s cutoff, so the
      // fallback is correct behavior, not a defect. Do not fail on network luck.
      return {
        skip: `Jev answered in ${Math.round(latency)}ms, beyond the 1.2s client timeout; fallback is expected`,
      };
    }
    // The client gives Jev 1.2s; if the service answers in time but the binary
    // still falls back, the response schema is the thing to look at.
    t.eq(
      envelope?.execution_gear,
      "GEAR_1_JEV",
      "a 2xx answer within the 1.2s client timeout produces GEAR_1_JEV",
    );
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderSummary(report) {
  const rows = report.checks
    .map((entry) => {
      const failed = entry.assertions.filter((assertion) => !assertion.ok);
      const detail =
        entry.status === "FAIL"
          ? failed.map((assertion) => assertion.label).join("; ")
          : entry.status === "SKIP"
            ? entry.skipReason ?? ""
            : `${entry.assertions.length} assertions`;
      return `| ${entry.id} | ${entry.status} | ${entry.title} | ${detail.replace(/\|/g, "\\|")} |`;
    })
    .join("\n");

  const failures = report.checks
    .filter((entry) => entry.status === "FAIL")
    .map((entry) => {
      const lines = entry.assertions
        .filter((assertion) => !assertion.ok)
        .map((assertion) => `- \`${assertion.label}\`\n  - ${assertion.detail.replace(/\n/g, "\n  - ")}`);
      const commands = entry.commands
        .map((command) => `  - \`${command.args}\` -> exit ${command.exit}${command.timedOut ? " (timed out)" : ""}`)
        .join("\n");
      return `### ${entry.id} ${entry.title}\n\n${lines.join("\n")}\n\nCommands:\n${commands}`;
    })
    .join("\n\n");

  const observations = report.checks
    .filter((entry) => entry.observations.length > 0)
    .map((entry) =>
      `- **${entry.id}**: ${entry.observations
        .map((observation) => `${observation.label} = ${observation.value}`)
        .join("; ")}`,
    )
    .join("\n");

  return [
    "# dot-test-digest acceptance run",
    "",
    `- **Run**: \`${report.run_id}\``,
    `- **Started**: ${report.started_at}`,
    `- **Finished**: ${report.finished_at}`,
    `- **Binary**: \`dist/index.js\` (package ${report.tool.packageVersion}, reports ${report.tool.reportedVersion})`,
    `- **Spec**: ${report.tool.specVersion}`,
    `- **Node**: ${report.tool.node}`,
    `- **Cache used**: \`${report.environment.cache}\` (copied into \`./cache/\`)`,
    `- **Result**: **${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped**`,
    "",
    report.preflight.length > 0
      ? `> ${report.preflight.join("\n> ")}`
      : "> Preflight clean.",
    "",
    "| # | Result | Check | Detail |",
    "| :-- | :-- | :-- | :-- |",
    rows,
    "",
    failures.length > 0 ? `## Failures\n\n${failures}` : "## Failures\n\nNone.",
    "",
    observations.length > 0 ? `## Observations (not assertions)\n\n${observations}` : "",
    "",
    "## How to hand this back",
    "",
    "Send the path of this file (or the whole run directory) to your assistant. `report.json` has",
    "the machine-readable copy, `transcript.log` the console copy, and `artifacts/` the raw",
    "stdout/stderr of every command that was run.",
    "",
  ].join("\n");
}

async function writeReports(startedAt, finishedAt) {
  const summary = { pass: 0, fail: 0, skip: 0 };
  for (const entry of checks) {
    if (entry.status === "PASS") summary.pass += 1;
    else if (entry.status === "FAIL") summary.fail += 1;
    else summary.skip += 1;
  }

  const report = {
    run_id: path.basename(OUT),
    started_at: startedAt,
    finished_at: finishedAt,
    tool: {
      packageVersion: PKG.version,
      reportedVersion: reportedVersion(),
      specVersion: SPEC_VERSION,
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
    },
    environment: { cache: CACHE, repo: REPO },
    preflight,
    summary,
    // `streams` duplicates artifacts/<id>.txt, so keep it out of the JSON.
    checks: checks.map(({ streams, ...rest }) => rest),
  };

  await fsp.writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(OUT, "summary.md"), renderSummary(report), "utf8");
  await fsp.writeFile(path.join(OUT, "transcript.log"), `${transcript.join("\n")}\n`, "utf8");
  await fsp.writeFile(path.join(REPO, ".acceptance", "LATEST"), `${OUT}\n`, "utf8");
  return report;
}

let cachedVersion = null;
function reportedVersion() {
  return cachedVersion ?? "unavailable";
}

async function main() {
  show("dot-test-digest acceptance harness");
  show(`  repo:  ${REPO}`);
  show(`  out:   ${OUT}`);
  show(`  cache: ${CACHE} (throwaway)`);
  show("");

  if (!fs.existsSync(TOOL)) {
    console.error(
      "harness: dist/index.js is missing. Run `pnpm install && pnpm build` first.",
    );
    process.exit(2);
  }
  if (!fs.existsSync(VITEST)) {
    console.error("harness: node_modules/vitest is missing. Run `pnpm install` first.");
    process.exit(2);
  }

  await fsp.mkdir(ART, { recursive: true });
  await fsp.mkdir(CACHE, { recursive: true });
  await buildFixtures();

  const startedAt = new Date().toISOString();

  // Preflight: is the build older than the sources it claims to implement?
  const distMtime = fs.statSync(TOOL).mtimeMs;
  let newestSource = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else newestSource = Math.max(newestSource, fs.statSync(absolute).mtimeMs);
    }
  };
  walk(path.join(REPO, "src"));
  if (distMtime < newestSource) {
    preflight.push("WARNING: dist/index.js is older than src/. Run `pnpm build` before trusting this run.");
  }

  const versionRun = await runProcess(process.execPath, [TOOL, "--version"], { env: baseEnv() });
  cachedVersion = versionRun.code === 0 ? versionRun.stdout.toString("utf8").trim() : "unavailable";

  await runChecks();

  const finishedAt = new Date().toISOString();
  const report = await writeReports(startedAt, finishedAt);

  // Keep an inspectable copy of everything the tool wrote, even though the
  // live cache lives in the system temp dir.
  await fsp.cp(CACHE, path.join(OUT, "cache"), { recursive: true }).catch(() => {});

  show("");
  show("------------------------------------------------------------");
  show(`  PASS ${report.summary.pass}   FAIL ${report.summary.fail}   SKIP ${report.summary.skip}`);
  for (const line of preflight) show(`  ${line}`);
  show("");
  show(`  Summary:    ${path.join(OUT, "summary.md")}`);
  show(`  Machine:    ${path.join(OUT, "report.json")}`);
  show(`  Transcript: ${path.join(OUT, "transcript.log")}`);
  show(`  Artifacts:  ${ART}`);
  show("------------------------------------------------------------");

  process.exitCode = report.summary.fail > 0 ? 1 : 0;
}

await main().catch((error) => {
  console.error("harness crashed:", error);
  process.exit(2);
});
