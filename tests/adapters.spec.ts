import { describe, expect, it } from "vitest";
import { ADAPTERS, classifyMessage, runGear0, selectAdapter } from "../src/adapters/index.js";
import type { CapturedLine } from "../src/runner/capture.js";

function lines(text: string): CapturedLine[] {
  return text.split("\n").map((line, index) => ({
    stream: "stdout" as const,
    text: line,
    line: index + 1,
  }));
}

const VITEST_FAILURE = ` FAIL  tests/auth.spec.ts > login > rejects expired token
AssertionError: expected 200 to be 401
Expected: 401
Received: 200
 ❯ parseToken (src/auth/jwt.ts:28:19)
 ❯ node_modules/vitest/dist/chunk.js:1:1

 Test Files  1 failed | 31 passed (32)
      Tests  1 failed | 239 passed (240)`;

const VITEST_PASS = ` ✓ tests/auth.spec.ts (12 tests) 640ms
 Test Files  32 passed (32)
      Tests  240 passed (240)`;

const VITEST_COMPACT = ` RUN  v2.1.9 /work/repo

 ❯ file-01.spec.ts (1 test | 1 failed) 5ms
   × ACCEPTANCE cascade file 01 > case 0 5ms
     → token.split is not a function

⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  file-01.spec.ts > ACCEPTANCE cascade file 01 > case 0
 FAIL  file-02.spec.ts > ACCEPTANCE cascade file 02 > case 0
TypeError: token.split is not a function
 ❯ parseToken src/helper.ts:5:20
 ❯ file-01.spec.ts:10:11
 ❯ node_modules/vitest/dist/chunk.js:1:1

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 Test Files  2 failed (2)
      Tests  2 failed (2)`;

const VITEST_COMPACT_INLINE = ` ❯ tests/auth.spec.ts (1 test | 1 failed) 640ms
   × login > rejects expired token 10ms
     → expected 200 to be 401
 ❯ parseToken src/auth/jwt.ts:28:19

 Test Files  1 failed (32)
      Tests  1 failed | 239 passed (240)`;

const TSC = `src/auth/jwt.ts(28,19): error TS2339: Property 'split' does not exist on type 'Token'.
src/auth/session.ts(12,5): error TS2339: Property 'split' does not exist on type 'Token'.
src/import.ts(3,10): error TS2307: Cannot find module './helprs' or its corresponding type declarations.`;

const PYTEST = `============================= test session starts ==============================
collected 3 items

=================================== FAILURES ===================================
___________________________________ test_total ___________________________________

    def test_total():
>       assert cart.total() == 100
E       AssertionError: assert 99 == 100

tests/test_cart.py:12: in test_total
    assert cart.total() == 100
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_total - AssertionError: assert 99 == 100
========================= 1 failed, 2 passed in 0.12s =========================`;

const CARGO = `   Compiling app v0.1.0
error[E0308]: mismatched types
 --> src/main.rs:4:9
  |
4 |     let x: u8 = "s";
  |         ^^^^^^ expected \`u8\`, found \`&str\`

thread 'tests::parse' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`;

const GO = `--- FAIL: TestTotal (0.00s)
    cart_test.go:12: got 99, want 100
FAIL
exit status 1
FAIL	example.com/cart	0.002s`;

describe("registry", () => {
  it("exposes four adapters", () => {
    expect(ADAPTERS.map((a) => a.name)).toEqual([
      "js-test",
      "tsc-eslint",
      "python",
      "rust-go",
    ]);
  });

  it("selects the vitest grammar for a vitest stream", () => {
    expect(selectAdapter(lines(VITEST_FAILURE).map((l) => l.text))?.name).toBe("js-test");
  });

  it("selects the go grammar, not js-test, for a go stream", () => {
    expect(selectAdapter(lines(GO).map((l) => l.text))?.name).toBe("rust-go");
  });

  it("returns null when nothing matches", () => {
    expect(runGear0(lines("hello\nworld"))).toBeNull();
  });
});

describe("js-test adapter", () => {
  it("extracts the failing test, its diff and its frames", () => {
    const result = runGear0(lines(VITEST_FAILURE));
    expect(result?.counts).toEqual({ passed: 239, failed: 1, skipped: 0 });
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("login > rejects expired token");
    expect(failure?.errorKind).toBe("ASSERTION_FAILURE");
    expect(failure?.message).toContain("expected 200 to be 401");
    expect(failure?.diff).toEqual({ expected: "401", received: "200" });
    expect(failure?.frames).toEqual([
      "parseToken (src/auth/jwt.ts:28:19)",
      "node_modules/vitest/dist/chunk.js:1:1",
    ]);
  });

  it("reads counts from a clean passing run and produces no failures", () => {
    const result = runGear0(lines(VITEST_PASS));
    expect(result?.counts).toEqual({ passed: 240, failed: 0, skipped: 0 });
    expect(result?.failures).toEqual([]);
  });

  it("parses the non-TTY compact reporter into one failure per test", () => {
    const result = runGear0(lines(VITEST_COMPACT));
    expect(result?.counts).toEqual({ passed: 0, failed: 2, skipped: 0 });
    const failures = result?.failures ?? [];
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.testName)).toEqual([
      "ACCEPTANCE cascade file 01 > case 0",
      "ACCEPTANCE cascade file 02 > case 0",
    ]);
    expect(failures.map((f) => f.testFile)).toEqual(["file-01.spec.ts", "file-02.spec.ts"]);
    for (const failure of failures) {
      expect(failure.message).toBe("TypeError: token.split is not a function");
      expect(failure.frames).toContain("parseToken src/helper.ts:5:20");
      expect(failure.errorKind).toBe("RUNTIME_EXCEPTION");
    }
    // The banner must never become a test or a frame.
    expect(failures.some((f) => f.testName?.includes("tests |"))).toBe(false);
    expect(failures.some((f) => f.frames.some((frame) => frame.includes("tests |")))).toBe(false);
  });

  it("keeps inline stacks from a TTY reporter and strips the row duration", () => {
    const [failure] = runGear0(lines(VITEST_COMPACT_INLINE))?.failures ?? [];
    expect(failure?.testName).toBe("login > rejects expired token");
    expect(failure?.testFile).toBe("tests/auth.spec.ts");
    expect(failure?.message).toBe("expected 200 to be 401");
    expect(failure?.diff).toEqual({ expected: "401", received: "200" });
    expect(failure?.frames).toEqual(["parseToken src/auth/jwt.ts:28:19"]);
  });

  it("classifies an unresolved import as SYNTAX_IMPORT_ERROR", () => {
    const stream = ` FAIL  tests/discount.spec.ts > applies discount
Error: Failed to resolve import "./helprs" from "tests/discount.spec.ts". Does the file exist?
 ❯ tests/discount.spec.ts:3:1

      Tests  1 failed (1)`;
    const [failure] = runGear0(lines(stream))?.failures ?? [];
    expect(failure?.errorKind).toBe("SYNTAX_IMPORT_ERROR");
  });
});

describe("tsc adapter", () => {
  it("parses one diagnostic per error line", () => {
    const result = runGear0(lines(TSC));
    expect(result?.failures).toHaveLength(3);
    expect(result?.counts.failed).toBe(3);
    expect(result?.failures.map((f) => f.errorKind)).toEqual([
      "TYPE_COMPILE_ERROR",
      "TYPE_COMPILE_ERROR",
      "SYNTAX_IMPORT_ERROR",
    ]);
    expect(result?.failures[0]?.frames).toEqual(["src/auth/jwt.ts:28:19"]);
    expect(result?.failures[0]?.message).toBe("TS2339: Property 'split' does not exist on type 'Token'.");
  });
});

describe("python adapter", () => {
  it("parses the traceback block instead of duplicating it from the summary", () => {
    const result = runGear0(lines(PYTEST));
    expect(result?.counts).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(result?.failures).toHaveLength(1);
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("test_total");
    expect(failure?.errorKind).toBe("ASSERTION_FAILURE");
    expect(failure?.frames).toEqual(["tests/test_cart.py:12"]);
  });
});

describe("rust-go adapter", () => {
  it("parses a rustc span and a panic", () => {
    const result = runGear0(lines(CARGO));
    expect(result?.counts).toEqual({ passed: 2, failed: 1, skipped: 0 });
    const kinds = result?.failures.map((f) => f.errorKind) ?? [];
    expect(kinds).toContain("TYPE_COMPILE_ERROR");
    expect(kinds).toContain("RUNTIME_EXCEPTION");
    expect(result?.failures.find((f) => f.errorKind === "RUNTIME_EXCEPTION")?.frames).toEqual([
      "src/lib.rs:10:5",
    ]);
  });

  it("parses a go test failure location", () => {
    const result = runGear0(lines(GO));
    const [failure] = result?.failures ?? [];
    expect(failure?.testName).toBe("TestTotal");
    expect(failure?.message).toBe("got 99, want 100");
    expect(failure?.frames).toEqual(["cart_test.go:12"]);
  });
});

describe("classifyMessage", () => {
  it.each([
    ["AssertionError: expected 1 to be 2", "ASSERTION_FAILURE"],
    ["Cannot find module './x'", "SYNTAX_IMPORT_ERROR"],
    ["Timeout of 5000ms exceeded", "TIMEOUT_OR_CONN_REFUSED"],
    ["ECONNREFUSED 127.0.0.1:5432", "TIMEOUT_OR_CONN_REFUSED"],
    ["TypeError: token.split is not a function", "RUNTIME_EXCEPTION"],
    ["SyntaxError: The requested module './cart.mjs' does not provide an export named 'missingThing'", "RUNTIME_EXCEPTION"],
  ] as const)("classifies %s", (message, kind) => {
    expect(classifyMessage(message)).toBe(kind);
  });
});

describe("tap grammar", () => {
  it("parses a TAP block from node:test", () => {
    const stream = [
      "not ok 1 - cart totals",
      "  ---",
      "  error: |-",
      "    AssertionError: expected 99 to be 100",
      "  ...",
      "1..1",
      "# tests 1",
      "# pass 0",
      "# fail 1",
    ].join("\n");
    const result = runGear0(lines(stream));
    expect(result?.adapter).toBe("js-test");
    expect(result?.counts.failed).toBe(1);
    expect(result?.failures).toHaveLength(1);
    expect(result?.failures[0]?.errorKind).toBe("ASSERTION_FAILURE");
  });
});
