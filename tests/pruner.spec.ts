import { describe, expect, it } from "vitest";
import {
  isPassingNoise,
  normalizeLine,
  normalizeLines,
  stripAnsi,
  stripPassingNoise,
} from "../src/pruner/ansi-stripper.js";

describe("stripAnsi", () => {
  it("removes CSI colour codes", () => {
    expect(stripAnsi("\u001b[32m✓\u001b[39m login")).toBe("✓ login");
  });

  it("removes OSC hyperlink sequences", () => {
    expect(stripAnsi("\u001b]8;;https://x.dev\u0007click\u001b]8;;\u0007")).toBe("click");
  });

  it("keeps plain text untouched", () => {
    expect(stripAnsi("TypeError: token.split is not a function")).toBe(
      "TypeError: token.split is not a function",
    );
  });
});

describe("normalizeLine", () => {
  it("keeps only the text after the last carriage return (spinner overwrite)", () => {
    expect(normalizeLine("⠋ running...\r✓ done")).toBe("✓ done");
  });

  it("strips trailing whitespace and escape codes", () => {
    expect(normalizeLine("\u001b[2K   12 tests   ")).toBe("   12 tests");
  });

  it("leaves an empty line empty", () => {
    expect(normalizeLine("")).toBe("");
  });

  it("keeps the text of a CRLF-terminated line", () => {
    expect(normalizeLine("Tests  1 failed (1)\r")).toBe("Tests  1 failed (1)");
    expect(normalizeLine("progress 10%\rprogress 100%\r")).toBe("progress 100%");
  });
});

describe("normalizeLines", () => {
  it("preserves the number of lines so raw-log pointers stay valid", () => {
    expect(normalizeLines("a\rb\n\nc")).toEqual(["b", "", "c"]);
  });
});

describe("passing noise", () => {
  it.each([
    "  ✓ login works 12ms",
    "✔ parse tokens",
    "PASS  tests/auth.spec.ts",
    "ok  1  node/test",
    "Test Files  32 passed (32)",
    "12 passing (640ms)",
  ])("treats %s as noise", (line) => {
    expect(isPassingNoise(line)).toBe(true);
  });

  it("keeps failures and stack frames", () => {
    expect(isPassingNoise("  ✕ login rejects expired token")).toBe(false);
    expect(isPassingNoise("TypeError: token.split is not a function")).toBe(false);
    expect(isPassingNoise("   at parseToken (src/auth/jwt.ts:28:19)")).toBe(false);
  });

  it("drops only the noise from a stream", () => {
    const stream = ["  ✓ a", "  ✕ b", "PASS tests/x.spec.ts"];
    expect(stripPassingNoise(stream)).toEqual(["  ✕ b"]);
  });
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isExternalFrame,
  pruneStack,
  readSignalWindow,
  toRepoRelative,
  topRepoFrame,
} from "../src/pruner/stack-pruner.js";

const REPO = "/work/repo";

describe("isExternalFrame", () => {
  it.each([
    "at node_modules/vitest/dist/chunk.js:1:1",
    "at node:internal/modules/cjs/loader:1234:14",
    "at /nix/store/abc123-python-3.11/lib/python3.11/site.py:10:1",
    "at .venv/lib/python3.11/site-packages/requests/api.py:61:9",
    "at /usr/lib/node_modules/tsc/lib/tsc.js:9:9",
    "at /rustc/abc/library/std/src/panic.rs:1:1",
  ])("flags %s as external", (frame) => {
    expect(isExternalFrame(frame)).toBe(true);
  });

  it.each([
    "at parseToken (src/auth/jwt.ts:28:19)",
    "at Object.<anonymous> (tests/login.spec.ts:12:5)",
    "File \"/work/repo/app/main.py\", line 12, in handler",
  ])("keeps %s as a repository frame", (frame) => {
    expect(isExternalFrame(frame)).toBe(false);
  });
});

describe("pruneStack", () => {
  it("keeps five repository frames plus one external boundary frame", () => {
    const frames = [
      "at parseToken (src/auth/jwt.ts:28:19)",
      "at login (src/auth/session.ts:44:11)",
      "at run (src/app/router.ts:9:3)",
      "at main (src/index.ts:4:1)",
      "at start (src/boot.ts:2:1)",
      "at six (src/extra.ts:1:1)",
      "at node_modules/vitest/dist/chunk.js:1:1",
      "at node_modules/vitest/dist/other.js:2:2",
    ];
    expect(pruneStack(frames, REPO)).toEqual([
      "at parseToken (src/auth/jwt.ts:28:19)",
      "at login (src/auth/session.ts:44:11)",
      "at run (src/app/router.ts:9:3)",
      "at main (src/index.ts:4:1)",
      "at start (src/boot.ts:2:1)",
      "at node_modules/vitest/dist/chunk.js:1:1",
    ]);
  });

  it("never spends the boundary slot on an engine frame", () => {
    const frames = [
      "at parseToken (src/auth/jwt.ts:28:19)",
      "new Promise (<anonymous>)",
      "async Promise.all (index 0)",
      "at node_modules/vitest/dist/chunk.js:1:1",
    ];
    expect(pruneStack(frames, REPO)).toEqual([
      "at parseToken (src/auth/jwt.ts:28:19)",
      "at node_modules/vitest/dist/chunk.js:1:1",
    ]);
  });

  it("drops an external frame that never follows a repository frame", () => {
    const frames = ["at node_modules/x/index.js:1:1", "at main (src/index.ts:4:1)"];
    expect(pruneStack(frames, REPO)).toEqual(["at main (src/index.ts:4:1)"]);
  });

  it("returns an empty stack for an all-external trace", () => {
    expect(pruneStack(["at node_modules/x/index.js:1:1"], REPO)).toEqual([]);
  });
});

describe("topRepoFrame", () => {
  it("returns the first repository frame as a relative file:line:col", () => {
    const frames = [
      "at node_modules/vitest/dist/chunk.js:1:1",
      "at parseToken (src/auth/jwt.ts:28:19)",
    ];
    expect(topRepoFrame(frames, REPO)).toEqual({
      location: "src/auth/jwt.ts:28:19",
      file: "src/auth/jwt.ts",
      line: 28,
      column: 19,
    });
  });

  it("returns null when nothing is a repository frame", () => {
    expect(topRepoFrame(["at node_modules/x/index.js:1:1"], REPO)).toBeNull();
  });
});

describe("toRepoRelative", () => {
  it("keeps relative paths relative and strips a repository prefix", () => {
    expect(toRepoRelative("src/auth/jwt.ts", REPO)).toBe("src/auth/jwt.ts");
    expect(toRepoRelative("/work/repo/src/auth/jwt.ts", REPO)).toBe("src/auth/jwt.ts");
  });

  it("keeps outside paths intact rather than emitting ../../", () => {
    expect(toRepoRelative("/other/place/file.ts", REPO)).toBe("/other/place/file.ts");
  });
});

describe("readSignalWindow", () => {
  it("returns five lines with the failing line marked", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-window-"));
    const file = path.join(dir, "jwt.ts");
    fs.writeFileSync(file, "line1\nline2\nline3\nline4\nline5\nline6\nline7\n");
    expect(readSignalWindow(file, 4, 2, dir)).toBe(
      ["2 | line2", "3 | line3", "4 > line4", "5 | line5", "6 | line6"].join("\n"),
    );
  });

  it("clamps at the start of the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-window-"));
    const file = path.join(dir, "jwt.ts");
    fs.writeFileSync(file, "only\n");
    expect(readSignalWindow(file, 1, 2, dir)).toBe("1 > only");
  });

  it("returns an empty string when the file is gone", () => {
    expect(readSignalWindow("/definitely/not/here.ts", 3, 2, REPO)).toBe("");
  });

  it("honours --context-lines=0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-window-"));
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "a\nb\nc\n");
    expect(readSignalWindow(file, 2, 0, dir)).toBe("2 > b");
  });
});
