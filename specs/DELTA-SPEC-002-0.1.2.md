# Delta Specification: `SPEC-002-DOT-TEST-DIGEST` v0.1.1 → v0.1.2

| Field | Value |
| :--- | :--- |
| **Delta ID** | `DELTA-SPEC-002-ACCEPTANCE-2026-10-31` |
| **Amends** | `specs/SPEC-002-DOT-TEST-DIGEST.md` v0.1.1 |
| **Status** | `APPLIED` — deltas `Δ-1`–`Δ-5` are incorporated in `specs/SPEC-002-DOT-TEST-DIGEST.md` v0.1.2 (2026-10-31) |
| **Date** | 2026-10-31 |
| **Trigger** | First acceptance run of the built binary (`scripts/acceptance/run-acceptance.mjs`) |
| **Evidence** | `.acceptance/run-2026-10-31_03-37-56-321/` (`summary.md`, `report.json`, `artifacts/`, `cache/`); gitignored, regenerate with `pnpm acceptance` |
| **Environment** | Node `v22.22.0`, Vitest `2.1.9`, Linux, child `stdout` piped (non-TTY) |
| **Result** | `13 PASS / 4 FAIL / 1 SKIP` — C04, C05, C06, C14 failed; C18 skipped (no `TYPESAFE_API_KEY`) |
| **Verdict** | Four failures, two implementation defects and two specification gaps. No invariant needs to be weakened; `CT-2` needs to become an end-to-end, non-TTY test. |

---

## 1. Scope of this delta

This document records what an end-to-end acceptance run changed our understanding of. It proposes
five normative deltas to `SPEC-002` and a small set of implementation changes required to satisfy
them. It did **not** edit `SPEC-002` v0.1.1; the deltas below are now applied as `SPEC-002` v0.1.2.

The acceptance harness asserts only what the spec already promises. Its four failures are therefore
either (a) implementation defects, (b) spec statements that cannot be satisfied as written, or
(c) both. They are not harness defects.

> Test-infrastructure note: the very first run also failed `C15` because the harness invoked
> `--scope-id=__SCOPE__` without substituting the placeholder. That was a harness bug, was fixed in
> `scripts/acceptance/run-acceptance.mjs`, and `C15` passes in the authoritative run above. It is
> not a product or spec finding.

---

## 2. Evidence

### 2.1 Checks that passed

| Check | Assertion | Observation |
| :--- | :--- | :--- |
| C01–C03 | CLI surface, usage errors, `INV-1`/`CT-1` | 2,610 lines / 159,792 bytes collapsed to **96 bytes**; raw log retained every line |
| C07–C13 | `INV-3` and the red-phase gate | `42`, `143`, `127`, `64`, `64`, `VALID_RED`, missing-export `VALID_RED` all as specified |
| C15–C17 | `CT-5`, unstructured fallback, self-host | isolated state, `BUILD_ERROR` with `L2589-L2620`, 141 own tests digested |
| C18 | Gear 1 wire contract | **SKIP**: no API key; not exercised by this run |

### 2.2 Checks that failed

| Check | Spec clause | Expected | Observed |
| :--- | :--- | :--- | :--- |
| C04 | `INV-2`, `CT-2` | `1 cluster`, `affected_count: 50`, at most one external boundary frame | `2 clusters`, `x100` and `x1`, `top_frame: unknown:0:0`, a file banner inside `pruned_stack` |
| C05 | `INV-2`, `INV-4`, §4.1 schema | `total_clusters: 1`, `affected_count: 50`, valid `L<n>-L<m>`, `signal_window` with context | `total_clusters: 2`, `affected_count: 100`, `pruned_stack: ["file-03.spec.ts (5 tests \| 5 failed) 10ms"]`, `signal_window: ""` |
| C06 | §4.2 `SignalWindow` | `top_frame` = existing repo file, window marks the line with `>` | `top_frame: "unknown:0:0"`; empty window; nothing to read from disk |
| C14 | §4.3 `RedGreenDelta` | `delta: +1 newly passing, 0 regressions` | `delta: +2 newly passing`; baseline held two identifiers for one test |

### 2.3 Raw runner output (the input the adapter actually received)

Vitest's default reporter is not a TTY here, so it emits its compact (“basic”) form in two sections.
Inline failures:

```
 ❯ file-05.spec.ts (5 tests | 5 failed) 9ms
   × ACCEPTANCE cascade file 05 > case 0 5ms
     → value.split is not a function
```

The deduplicated summary:

```
⎯⎯⎯⎯⎯⎯ Failed Tests 50 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  file-01.spec.ts > ACCEPTANCE cascade file 01 > case 0
 ...
 FAIL  file-10.spec.ts > ACCEPTANCE cascade file 10 > case 4
TypeError: value.split is not a function
 ❯ frame35 node_modules/@acceptance/sink/index.cjs:37:40
 ...
 ❯ frame26 node_modules/@acceptance/sink/index.cjs:28:34

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/50]⎯
```

The stack is printed **once** for all 50 summary rows, and V8 prints only **10 frames** (the
fixture's repository frame sits below that cutoff). The adapter's current grammar (v0.1.1) does not
model any of this, which produces the observed damage:

* `❯ file-05.spec.ts (5 tests | 5 failed) 9ms` is taken as a stack frame and creates a phantom failure;
* `× ACCEPTANCE … case 0 5ms` keeps the `5ms` timing in the test name;
* `→ value.split is not a function` is not recognized as a message (it contains no `Error` token);
* the 50 `FAIL file > test` rows are counted *in addition to* the 50 inline rows;
* the one shared stack is attached only to the last failure.

Result: **101 recorded failures for 50 failing tests**, of which 100 collapse into one bucket with
`message: "Unknown test failure"`, `top_frame: unknown:0:0`, an empty `signal_window`, and the file
banner as the only “frame”.

For the single-test red run (C14), the same duplication yields two baseline identities for one
failing test — `ACCEPTANCE red case 8ms` (inline row) and `ACCEPTANCE red case` (summary row) — so
the green run reports `+2 newly passing`.

### 2.4 Root causes

| ID | Kind | Cause |
| :--- | :--- | :--- |
| **RC-1** | implementation | `src/adapters/js-test.ts` does not parse the non-TTY Vitest reporter: file banners, timing suffixes, `→` messages, separators, and the two-section layout are all unhandled. |
| **RC-2** | implementation | Failure identity is not canonical and duplicate representations are not reconciled; `affected_count` and `RedGreenDelta` are computed over parse records instead of distinct tests. |
| **RC-3** | specification | §4.2 describes `at <symbol> (<file>:<line>:<col>)` frames only, and `CT-2` does not say the fixture must be run through the CLI in non-TTY mode. The unit compliance test builds synthetic `RawFailure` objects, so RC-1/RC-2 cannot surface. |
| **RC-4** | specification | `CT-2` requires “`0` `node_modules` stack frames”, while `INV-4` allows one external boundary frame. The two clauses contradict each other. |

---

## 3. Normative deltas

Each delta states the target location in `SPEC-002`, the new requirement, and the test that proves it.
RFC 2119 keywords keep their usual meaning.

### Δ-1 — §4.2: non-TTY JavaScript/TypeScript runner grammar

**Problem.** The wrapper always pipes the child, so Vitest, Jest and `node --test` run in their
non-TTY reporter modes. The spec names only `at`-style frames and TAP/Playwright headers.

**Add §4.2.1, “Piped (non-TTY) runner output”:**

> When the child's `stdout`/`stderr` are pipes — the normal case for this wrapper — the JavaScript /
> TypeScript adapter MUST additionally recognize the compact reporter forms:
>
> a. A file banner `❯ <file> (<n> tests | <m> failed) <duration>` is **metadata**. It MUST NOT create
>    a `FailureCluster`, MUST NOT be recorded as a stack frame, and MUST NOT terminate the raw-line
>    range of the failures that follow it.
> b. An inline failing row `× <name> <duration>` (or `✕`/`✗`) MUST have the trailing duration removed
>    before `<name>` is used as a test identifier. Durations are presentation, never identity.
> c. A continuation row `→ <message>` MUST be stored as the failure message.
> d. The `Failed Tests <n>` summary and its `FAIL <file> > <name>` rows describe failures that were
>    already listed inline. They MUST be reconciled with the inline rows, not counted again.
> e. A stack printed once for a deduplicated group of summary rows MUST be attributed to every row in
>    that group, so each member carries the same frames for fingerprinting, pruning and `top_frame`.
> f. Separators and counters (`[1/50]`, `Test Files …`, `Tests …`, `Duration …`) MUST never become
>    frames, messages or failures.

**Proof.** C04, C05 and C06 of the acceptance harness; new unit cases in `tests/adapters.spec.ts`
with the exact two-section fixture in §2.3.

### Δ-2 — §4.2: one failure per test and accounting consistency

**Problem.** Parsing the same failure twice is currently indistinguishable from two failures, and no
invariant ties the cluster totals back to the runner summary.

**Add §4.2.2, “Failure reconciliation and accounting”:**

> For a given run, after all sources in the stream have been parsed, the runtime MUST emit **at most
> one** failure record per canonical test identity (Δ-3). Consequently:
>
> * `affected_count` MUST count distinct tests, not parse records, and `Σ affected_count` over all
>   deduplicated clusters MUST equal the number of distinct parsed failures — and therefore equal
>   `summary.failed` when no cluster is dropped by `--max-clusters` or the `INV-2` budget;
> * a grammar-parsed run MUST NOT report more failures than the runner's own summary
>   (`Σ affected_count <= summary.failed` in every case);
> * only actual stack-frame lines MAY enter `pruned_stack`; banners, messages, separators and
>   counters MUST be rejected by frame validation;
> * when no repository frame exists in the captured text, `top_frame` MUST be `unknown:0:0`,
>   `signal_window` MUST be empty, and the runtime MUST report that honestly rather than invent a
>   file or borrow the test file's name.

**Proof.** C04 (header cluster count and `x50`), C05 (`summary.total_clusters`, `affected_count`,
`pruned_stack` contents), and the equality assertion between `summary.failed` and the cluster sum.

### Δ-3 — §4.3: canonical test identity for baseline and delta

**Problem.** `RedGreenDelta` compares raw parsed names. Timing suffixes and the two reporter sections
make one test look like two.

**Amend §4.3, paragraph on state persistence:**

> Baseline entries and `RedGreenDelta` MUST use a canonical identity of the form
> `<repo-relative test file>::<test name>`, derived from the summary-section row (which carries the
> file) or from the preceding file banner plus the inline row. ANSI, timing suffixes, and duplicate
> representations of the same test MUST be removed before comparison. `newly_passing`,
> `still_failing` and `newly_broken_regressions` MUST count distinct identities. A single test that
> appears twice in one run's text contributes one identity and one count.

**Proof.** C14 (`+1` not `+2`); unit test that runs the same red→green sequence with the compact
reporter text and asserts the persisted baseline has length 1.

### Δ-4 — §6: `CT-2` becomes an end-to-end, non-TTY test

**Problem.** `CT-2` is currently a property of the adapter (synthetic `RawFailure` objects), not of
the CLI. It therefore cannot catch RC-1/RC-2. Its fixture (“35-frame `node_modules` stack trace”)
also cannot expose a repository frame under V8's 10-frame print limit when the throw site is inside
`node_modules`, so the `SignalWindow` half of `CT-2` is unsatisfiable for that fixture. Finally,
“`0` `node_modules` frames” contradicts `INV-4`, which permits one boundary frame.

**Replace `CT-2` with:**

> **Compliance Test 2 (`CT-2`: 50-to-1 Cascade Deduplication & Stack Pruning, end-to-end)**:
> Generate a fixture in which 50 tests across 10 files fail because a shared **repository** helper
> performs the failing operation (so the throw site is a repository frame and the printed stack may
> also contain external frames). Run the built binary as `dot-test-digest -- vitest run` with
> `stdout` piped (non-TTY). The emitted `compact-md` output MUST contain exactly `1` `FailureCluster`
> with `affected_count: 50`, **no** internal or third-party frames other than at most one external
> boundary frame (as permitted by `INV-4`), and an inlined 5-line `SignalWindow` from the helper
> file. Total `stdout` MUST be `<= 220 EstimatedToken`; the universal ceiling remains `INV-2`'s 600.
> The JSON envelope MUST report `summary.failed: 50`, `total_clusters: 1`, and
> `Σ affected_count = 50`.

**Note.** V8 prints at most 10 frames by default. The fixture MUST place the throwing repository
frame inside that window. A stack containing only `node_modules` frames is not sufficient to require
a `SignalWindow`; for such a run, Δ-2's honesty rule applies.

### Δ-5 — §6: `CT-2` wording aligned with `INV-4`

Replace “`0` `node_modules` stack frames” with:

> no frames from `node_modules`, language internals or standard libraries, except at most `1`
> external boundary frame immediately following a repository frame (`INV-4`).

This removes the `CT-2` ↔ `INV-4` contradiction without changing `INV-4`.

---

## 4. Implementation deltas required by this spec delta

These are not themselves normative, but they are the minimal work needed to make v0.1.2 true.

| Area | Change |
| :--- | :--- |
| `src/adapters/js-test.ts` | Added compact-reporter states: file banner (metadata), inline `×` row (duration stripped), `→` message, `Failed Tests` summary reconciliation, one shared stack attributed to the group, `[n/m]` separators ignored. A `Failed Suites` block stays on the generic grammar. |
| `src/pruner/failure-identity.ts` (new) | Canonical test-name normalisation (ANSI, decoration, `file > ` prefix, timing suffix), `canonicalTestId(file, name)` → `file::name`, and `uniqueFailures`. |
| `src/pruner/cluster-dedup.ts` | Calls `uniqueFailures` before grouping, so `affected_count` counts distinct tests. |
| `src/pruner/stack-pruner.ts` | Added `isFrameLike`; `pruneStack` rejects banners, messages, separators and counters. |
| `src/index.ts` | Baseline and delta are built from canonical identities; failures are deduplicated before accounting. `computeDelta` itself is unchanged because it now receives canonical, unique identities. |
| `tests/adapters.spec.ts` | Added the two-section compact fixture and an inline-stack TTY case; asserts one failure per test, duration-free names, `→` message, shared-stack attribution. |
| `tests/dedup-and-tdd.spec.ts` | Added the canonical-identity dedupe case (inline `… 8ms` + summary row → one cluster, `affected_count: 1`). |
| `scripts/acceptance/run-acceptance.mjs` | CT-2 fixture now throws in the repository helper (`src/helper.ts`) so the repository frame is inside V8's 10-frame window; the `node_modules` sink was removed. C04–C06 and C14 are the end-to-end oracle. |

---

## 5. Re-run gate

A v0.1.2 implementation is done when, on the same machine:

1. `pnpm build && node scripts/acceptance/run-acceptance.mjs` reports **`17 PASS / 0 FAIL / 1 SKIP`**
   (or `18 PASS` with `TYPESAFE_API_KEY`), and
2. `pnpm verify` passes with the new adapter and delta tests included, and
3. the C04 artifact shows `| 1 cluster |`, `x50`, a repository `top_frame`, and a 5-line window;
4. the C14 artifact shows `delta: +1 newly passing, 0 regressions`.

Checks C01, C02, C07–C13, C15–C17 must remain green; no invariant or ceiling is relaxed by this
delta.

**Result.** Satisfied on 2026-10-31 by run `run-2026-10-31_03-52-00-635`: **17 PASS / 0 FAIL /
1 SKIP**, `pnpm verify` green, C04 `1 cluster` / `x50` / repository `top_frame` / 5-line window,
C14 `delta: +1 newly passing, 0 regressions`. C18 remains skipped for want of `TYPESAFE_API_KEY`.

---

## 6. Open questions

1. **Shared-stack grouping.** When a summary section contains several distinct stack blocks (one per
   error type), attribution must be by adjacency: each block applies to the `FAIL` rows that precede
   it since the previous block. Confirm this is the intended rule before implementation.
2. **Truncated stacks.** The delta deliberately refuses to guess a frame when the runner prints none
   that resolves to the repository. Do we want an opt-in environment change (for example
   `NODE_OPTIONS=--stack-trace-limit=50`) for the child? Recommendation: **no** — the wrapper must
   not alter the child's runtime behavior (`INV-3` transparency).
3. **Identity source.** Inline rows carry no file; the summary row does. The delta makes the summary
   row authoritative when both exist. If a reporter emits inline rows without a summary section,
   identity falls back to `<banner file>::<inline name>`.
4. **TTY mode.** Out of scope: the wrapper always pipes. If a caller runs the digest of a
   already-captured TTY log, the `at`-frame grammar of v0.1.1 still applies; adding new TTY rules
   would be a separate delta.

---

## 7. Revision history

| Version | Date | Change |
| :--- | :--- | :--- |
| `applied-1` | 2026-10-31 | Applied as `SPEC-002` v0.1.2. Implementation landed in `src/pruner/failure-identity.ts`, the compact parser in `src/adapters/js-test.ts`, frame validation in `src/pruner/stack-pruner.ts`, and the CT-2 fixture in `scripts/acceptance/run-acceptance.mjs`; re-run gate met (`17 PASS / 0 FAIL / 1 SKIP`). |
| `draft-1` | 2026-10-31 | Initial delta after the first acceptance run (`run-2026-10-31_03-37-56-321`): five normative deltas and the implementation work they imply. |
