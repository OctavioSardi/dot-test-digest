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
