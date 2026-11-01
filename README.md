# dot-test-digest

Bounded output compressor for test runs, compilers and build tools.
Implements [`specs/SPEC-002-DOT-TEST-DIGEST.md`](specs/SPEC-002-DOT-TEST-DIGEST.md).

```bash
dot-test-digest --tdd-phase=green -- vitest run
dot-test-digest --format=json -- cargo build
dot-test-digest --no-jev -- tsc --noEmit
```

- **Pass:** one line, at most 160 bytes (`[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: …`).
- **Fail:** deduplicated failure clusters with a pruned stack and an inlined source window, at most 600 tokens.
- **Always:** the child's exit code (or `128 + signal`) is returned unchanged, and the full raw stream is kept in `~/.cache/dot-test-digest/logs/<run_id>.log`.

Gear 1 (Jev `jev-1.13.0`) is used only for unstructured failures above 150 lines and needs `TYPESAFE_API_KEY`.
Without it, the heuristic fallback still narrows the log.

**Privacy.** Gear 1 is the only part of the tool that uses the network. When `TYPESAFE_API_KEY` is set and `--no-jev`
is not passed, it sends excerpts of the failing run's log (the failure windows and the tail, bounded in size) to
`api.typesafe.ai`. Pass `--no-jev` to keep every run local. Without a key, nothing leaves your machine.

TDD state lives in `~/.cache/dot-test-digest/state-<scope_id>.json`; `--scope-id` isolates concurrent runs.
`DOT_TEST_DIGEST_HOME` relocates both caches.

## Example

The same small project (a cart module with one real bug and 29 vitest tests, 5 of them failing), run without and with the digest. Measured on 2026-11-01 with dot-test-digest 0.1.0, Node 20, vitest 2.1.9 and `--no-jev`; the log path is shortened.

```bash
vitest run                                  # raw
dot-test-digest --no-jev -- vitest run      # through the digest
```

**Raw:** 109 lines, 4,308 bytes (excerpt)

```text

 RUN  v2.1.9 /path/to/project

 ❯ tests/cart.test.ts (29 tests | 5 failed) 49ms
   × cart > discount 10% leaves 90% 21ms
     → expected 100 to be 900 // Object.is equality
   × cart > total without discount 3ms
     → expected +0 to be 1815 // Object.is equality
   × cart > total with 10% off 2ms
     → expected 182 to be 1634 // Object.is equality
   × cart > total with 100% off is free 2ms
     → expected 1815 to be +0 // Object.is equality
   × cart > first of an empty cart is undefined 2ms
     → Cannot read properties of undefined (reading 'name')

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

… (88 more lines: per-failure diffs and stack traces)
 Test Files  1 failed (1)
      Tests  5 failed | 24 passed (29)
   Start at  03:39:05
   Duration  663ms (transform 122ms, setup 0ms, collect 118ms, tests 49ms, environment 0ms, prepare 137ms)
```

**Digest:** 33 lines, 1,798 bytes (complete output), same exit code (`1`)

```text
[FAIL] 5 failed, 24 passed in 1517ms | 3 clusters | log: ~/.cache/dot-test-digest/logs/run_mvxa6iou671370c8.log
c_c7823024 ASSERTION_FAILURE x1 tests/cart.test.ts:11:69
  AssertionError: expected 1815 to be +0 // Object.is equality
  diff: expected 0 / received 1815
  tests/cart.test.ts:11:69
   9 |   it("total without discount", () => expect(total(items)).toBe(1815));
  10 |   it("total with 10% off", () => expect(total(items, 10)).toBe(1634));
  11 >   it("total with 100% off is free", () => expect(total(items, 100)).toBe(0));
  12 |   it("first item name", () => expect(first(items)).toBe("pen"));
  13 |   it("first of an empty cart is undefined", () => expect(first([])).toBeUndefined());
  tests: cart > total with 100% off is free
  raw: L11-L84
c_8bdc37b0 RUNTIME_EXCEPTION x1 src/cart.ts:10:50
  TypeError: Cannot read properties of undefined (reading 'name')
  Module.first src/cart.ts:10:50
  tests/cart.test.ts:13:58
   8 |   return d + tax(d); // bug propagates here
   9 | };
  10 > export const first = (items: Item[]) => items[0].name; // crashes on an empty cart
  tests: cart > first of an empty cart is undefined
  raw: L13-L102
c_992bb564 ASSERTION_FAILURE x1 tests/cart.test.ts:7:66
  AssertionError: expected 100 to be 900 // Object.is equality
  diff: expected 900 / received 100
  tests/cart.test.ts:7:66
  5 |   it("subtotal adds up", () => expect(subtotal(items)).toBe(1500));
  6 |   it("tax is 21%", () => expect(tax(1000)).toBe(210));
  7 >   it("discount 10% leaves 90%", () => expect(discount(1000, 10)).toBe(900));
  8 |   it("discount 50% leaves half", () => expect(discount(2000, 50)).toBe(1000));
  9 |   it("total without discount", () => expect(total(items)).toBe(1815));
  tests: cart > discount 10% leaves 90%
  raw: L5-L27
+2 more clusters (see log)
```

Fair reading of this example: vitest already prints a one-line summary of every failure at the top, so the raw output is not hard to scan here. The digest drops the repeated per-failure detail and adds a source window around each failing line, but it shows **3 of the 5 failures**; the other two are only counted (`+2 more clusters`). The full output is always in the log it names.

A passing run is one line (`[PASS] 29 passed, 0 failed in 1301ms | log: …`, 101 bytes against 262 bytes raw).

## Where it works well, and where it does not

These are measurements from small hand-made projects with the same bug in each, not a benchmark. Sizes are raw output against digest output.

| Case | Raw | Digest | Verdict |
| --- | --- | --- | --- |
| vitest (non-TTY), 5 of 29 failing | 110 lines, 4,308 B | 33 lines, 1,798 B | **Good.** Distinct failures become clusters with file, line, diff and a source window. Shows the first 3 clusters only. |
| vitest, all passing | 10 lines, 262 B | 1 line, 101 B | **Good.** |
| `node --test` (default or `--test-reporter=tap`), 4 of 26 failing | 214 lines, about 5.5 KB | 6 lines, 305 B | **Poor for debugging.** Four different failures are merged into one cluster, `RUNTIME_EXCEPTION x4 unknown:0:0 "Unknown test failure"`. The file and line and the actual values are lost, and the diff shown belongs to only one of the four tests. |
| `node --test --test-reporter=spec`, 4 failing | 172 lines, 6,851 B | 24 lines, 1,277 B | **Not recognized.** Reported as `BUILD_ERROR` with `0 failed, 0 passed`; you get the tail of the log. |
| `tsc`, 6 errors in 2 files | 8 lines, 714 B | 40 lines, 1,894 B | **Larger than the raw output.** The source windows outweigh the saving when there are only a few errors. |

**The TDD gate (`--tdd-phase=red`) is the most reliable part.** In every case I ran it gave the right verdict, and the exit code was `0` for `VALID_RED` and `64` for `INVALID_RED`:

| Red phase run | Status |
| --- | --- |
| vitest, an assertion fails | `VALID_RED` |
| `node --test` (default, tap or spec reporter), an assertion fails | `VALID_RED` |
| vitest, import of a missing module | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) |
| `node --test` (tap or spec reporter), import of a missing module | `INVALID_RED` |
| `node --test`, the test already passes | `INVALID_RED` |

For `node --test` the gate is right but its labels are weaker: assertion failures are reported as `RUNTIME_EXCEPTION`, and with the spec reporter as `UNSTRUCTURED_BUILD_ERROR`.

**Things to know before relying on it**

- Clusters are grouped by the shape of the error, not by root cause. One bug that produces different assertion messages makes several clusters, and a cap of about 600 tokens means only the first 3 are printed.
- The child process's exit code is passed through unchanged (observed in every run above).
- Grammars for pytest, `cargo test`, `go test`, jest, mocha, Playwright and eslint exist and are covered by fixtures in this repo's tests, but **I did not run them against real projects**. Treat them as untested in practice.
- Gear 1 (the optional Jev call) was not exercised: every measurement used `--no-jev`.

## Install

Needs Node >= 20 and [pnpm](https://pnpm.io). Clone, build, and put the `dot-test-digest` bin on your `PATH`:

```bash
git clone https://github.com/OctavioSardi/dot-test-digest && cd dot-test-digest
pnpm install && pnpm build && pnpm link --global
dot-test-digest --version
```

If `dot-test-digest` is not found afterwards, run `pnpm setup` and restart your shell: it puts pnpm's global bin directory on your `PATH`.

## Develop

```bash
pnpm install
pnpm verify     # typecheck + unit tests
pnpm build      # emits dist/ with the dot-test-digest bin
```

## License

[MIT](LICENSE) © 2026 Octavio Sardi and Flowdots.
