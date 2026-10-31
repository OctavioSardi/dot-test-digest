# Specification: `dot-test-digest` (Three-Gear Test, Compiler & Build Output Compressor)

| Field | Value |
| :--- | :--- |
| **Spec ID** | `SPEC-002-DOT-TEST-DIGEST` |
| **Status** | `DRAFT` |
| **Version** | `0.1.2` |
| **Date** | 2026-10-31 |
| **Supersedes** | `0.1.1` (2026-10-30) |
| **Target Runtime** | Node.js `>= 20.x` / TypeScript `5.x` |
| **Upstream Dependency** | `zod`, TypeSafe AI Jev API (`jev-1.13.0+`) |
| **Amended by** | `specs/INTEGRITY-SPEC-002.md` — findings `F1`–`F11`, resolutions `R1`–`R15`; `specs/DELTA-SPEC-002-0.1.2.md` — deltas `Δ-1`–`Δ-5` |

## 1. Normative Language & Terminology

The key words **"MUST"**, **"MUST NOT"**, **"REQUIRED"**, **"SHALL"**, **"SHALL NOT"**, **"SHOULD"**, **"SHOULD NOT"**, **"RECOMMENDED"**, **"MAY"**, and **"OPTIONAL"** in this document are to be interpreted as described in RFC 2119.

| Term | Definition |
| :--- | :--- |
| **`DigestEnvelope`** | The payload emitted to `stdout`. In `compact-md` (the default) it is bounded by `INV-1` on pass and `INV-2` on failure; in `json` it is the complete structured document of §4.1 and is not byte-bounded (§4.1.1). |
| **`FailureCluster`** | A deduplicated group of one or more failing tests or compiler diagnostics that share an identical `RootCauseFingerprint`. |
| **`RootCauseFingerprint`** | A deterministic hash `SHA256(error_kind + top_repo_frame_location + normalized_assertion_template)` used to collapse cascading failures into a single `FailureCluster`. |
| **`StackFramePruner`** | The Gear 0 filter that strips runtime internals and third-party dependency frames (`node_modules/`, `/nix/store/`, `.venv/`, stdlib) while preserving repository frames. |
| **`SignalWindow`** | A slice of repository source code read directly from disk around the top failing `file:line` frame — the failing line ± `--context-lines` lines (default 2) — with the failing line marked `>`, inlined into the `FailureCluster`. |
| **`TddPhaseGate`** | The state machine (`red`, `green`, `refactor`) that validates whether a test execution outcome satisfies the requested test-driven development phase transition. |
| **`RedGreenDelta`** | The stateful diff comparing the current test execution against the prior run's persisted state (`newly_passing`, `newly_broken_regressions`, `still_failing`). |
| **`EstimatedToken`** | The unit of every token ceiling here: `ceil(UTF-8 bytes / 4)`. It is a conservative proxy for a BPE tokenizer, not a measurement; wide characters can exceed the token intent while staying inside the byte budget. |

## 2. Purpose & System Scope

Standard test runners (`vitest`, `jest`, `pytest`, `cargo test`, `go test`, `playwright test`) and build or static-analysis tools (`tsc`, `eslint`, `ruff`, `nix build`) format their output for human terminal scrolling rather than bounded context consumption. A single test execution frequently emits ANSI escape sequences, progress spinners, thousands of lines of passing test checkmarks, verbose `console.log` debugging output, 40-frame deep `node_modules` stack traces, and 50 identical failure blocks when a single shared function throws an exception.

`dot-test-digest` SHALL operate as a drop-in, exit-code-transparent CLI wrapper (`dot-test-digest [flags] -- <command>`) that intercepts child process `stdout` and `stderr` streams and resolves them locally through a **Three-Gear Execution Hierarchy**:

1. **Gear 0 (Deterministic Grammar Parser, Stack Pruner & Deduplicator)**: Zero-token, `<15ms` local stream processing that strips ANSI/passing noise, parses structured runner outputs (`vitest`, `jest`, `pytest`, `cargo`, `go`, `tsc`), collapses cascading failures into deduplicated `FailureCluster` records, strips third-party stack frames, and inlines the 5-line `SignalWindow` from the local source file.
2. **Gear 1 (System-1 Jev Fault Classifier for Unstructured Build Logs)**: Sub-120ms discriminative log triage via the Jev API (`jev-1.13.0+`), invoked **only** when a command fails with more than 150 lines of unstructured output (such as raw `nix build`, `docker build`, C++/Rust linker dumps, or database migration crashes) that no Gear 0 grammar adapter matches.
3. **Gear 2 (Bounded Output Delivery & Raw Byte-Range Pointer)**: Emits the compact `DigestEnvelope` to `stdout` while persisting the unedited raw stream, byte for byte, to `~/.cache/dot-test-digest/logs/<run_id>.log` so callers can inspect a specific line range on demand only when deeper forensics are required. Every emitted `raw_log_lines` pointer MUST resolve to that file.

## 3. Architectural Invariants (Non-Negotiable Rules)

* **`INV-1` (Pass-State Ceiling, `compact-md`)**: When the wrapped command exits with code `0` (and satisfies the active `TddPhaseGate`), `dot-test-digest` MUST NOT write more than `160 bytes` **including the trailing newline** to `stdout` in the default `compact-md` format. All passing test names, compiler banners, deprecation warnings, and `stdout` logs MUST be suppressed. `--format=json` emits the structured envelope of §4.1 instead; it is exempt, because no conforming JSON document fits in 160 bytes (§4.1.1).
* **`INV-2` (Fail-State Ceiling & Cascade Deduplication)**: When multiple tests fail with the same `RootCauseFingerprint`, the runtime MUST collapse them into a single `FailureCluster` showing the stack trace and `SignalWindow` exactly once, accompanied by `affected_count` and at most 3 sample test names. In `compact-md`, total `stdout` on a failed run MUST NOT exceed `600 EstimatedTokens` (`2400 bytes`); when the budget is exhausted the runtime MUST drop the lowest-severity clusters first and append `+N more clusters (see log)` so the omission is never silent. `max_clusters` defaults to `5`.
* **`INV-3` (Strict Exit-Code Transparency)**: Except when explicitly blocking an invalid TDD phase transition under `INV-5`, `dot-test-digest` MUST exit with the exact integer exit code (`0..255`) or POSIX signal termination code (`128 + signal number`) of the underlying child process. A failure to persist the raw log or the TDD state file MUST NOT alter that code: it is reported on `stderr` and the run continues.
* **`INV-4` (Zero Third-Party Stack Pollution)**: Emitted stack traces MUST strip all frames originating from language internals or external package directories (`node:internal/*`, `node_modules/*`, `/nix/store/*`, `.venv/*`, `site-packages/*`, `/usr/lib/*`, Go/Rust stdlib) **and** all engine-only frames that name no file (`<anonymous>`, `(index N)`, `<frozen …>`), which are dropped outright and never occupy a slot. A `FailureCluster` retains at most 1 external boundary frame — the exact third-party function called by repository code, and only if it follows a repository frame — plus up to 5 repository frames, in original order: at most 6 entries.
* **`INV-5` (TDD Red-Phase Behavioral Gate)**: When invoked with `--tdd-phase=red`, the run is valid **if and only if** the child process fails (`exit_code != 0`) due to a behavioral test assertion failure or a **missing exported symbol under test** (`does not provide an export named`, `has no exported member`, `is not exported from`). If the command passes (`exit_code == 0`) OR fails due to a syntax error, broken test import path, or test-runner startup crash, `dot-test-digest` MUST emit `status: "INVALID_RED"` and exit with code `64` (`EX_USAGE`). A missing export MUST therefore be classified before the syntax tokens, even though Node reports it as a `SyntaxError`. When no grammar produced a failure block, the log itself decides: behavioral evidence in the captured text (an `AssertionError`, an `expected … to …` mismatch, a missing export, `is not a function`, `Cannot read propert`) makes the run `VALID_RED`; its absence makes it `INVALID_RED`. This keeps the gate usable for runners without a Gear 0 grammar (`--reporter=json`, junit, TAP variants).
* **`INV-6` (Strict Option Ceiling for Gear 1 Jev)**: Any unstructured log triage payload dispatched to the Jev API in Gear 1 MUST NOT exceed `255` candidate log-window options in a single `choice` question, and the serialized request MUST be budgeted to stay inside the model's 64k-token context. The option ceiling alone does not bound the request: window text is truncated and dropped by salience until it fits.

## 4. Functional Requirements & Behavioral Scenarios

### 4.1. Requirement: CLI Surface & `DigestEnvelope` Schema (`REQ-CLI-SURFACE`)

The binary SHALL accept flags preceding the `--` delimiter and pass all arguments following `--` verbatim to the spawned child process.

**Supported CLI Flags**:

| Flag | Type & Default | Description |
| :--- | :--- | :--- |
| `--tdd-phase` | `"red" \| "green" \| "refactor" \| "none"` (`"none"`) | Enforces phase transition rules (`INV-5`) and tracks `RedGreenDelta` state transitions. |
| `--format` | `"compact-md" \| "json"` (`"compact-md"`) | Output serialization format emitted to `stdout`. |
| `--max-clusters` | `integer` (`5`, max `15`) | Maximum number of distinct `FailureCluster` blocks emitted on failure. |
| `--context-lines` | `integer` (`2`, max `5`) | Number of source lines above and below the failing `file:line` included in `SignalWindow`. |
| `--scope-id` | `string` (auto-hashed `sha256(cwd)[0..12]`) | Scopes `state-<scope_id>.json` so concurrent runs in separate directories never collide. Explicit ids are sanitised to `[A-Za-z0-9._-]`. |
| `--no-jev` | `boolean` (`false`) | Disables Gear 1 Jev API fallback for offline execution, falling back to heuristic tail extraction. |
| `--retry-flakes` | `boolean` (`false`) | Permits one automatic re-run when Gear 1 reports the failure as transient (§4.4.3). |
| `-h`, `--help` | — | Prints usage to `stdout`; exits `0`. |
| `-v`, `--version` | — | Prints the version to `stdout`; exits `0`. |

Boolean flags also accept an explicit value (`--no-jev=false`); any value other than `true`/`false` is a usage error (`64`). Every unknown flag, missing value, out-of-range integer, or missing `--` delimiter is a usage error: diagnostic on `stderr`, exit `64`.

**`DigestEnvelope` Output Schema (`--format=json`)**:

```json
{
  "type": "object",
  "required": ["status", "exit_code", "execution_gear", "duration_ms", "summary", "raw_log_path"],
  "properties": {
    "status": {
      "type": "string",
      "enum": ["PASS", "FAIL", "VALID_RED", "INVALID_RED", "REGRESSION_DETECTED", "BUILD_ERROR"]
    },
    "tdd_phase": {
      "type": "string",
      "enum": ["red", "green", "refactor", "none"]
    },
    "exit_code": { "type": "integer" },
    "execution_gear": {
      "type": "string",
      "enum": ["GEAR_0_GRAMMAR", "GEAR_1_JEV", "GEAR_0_HEURISTIC_FALLBACK"]
    },
    "duration_ms": { "type": "integer" },
    "summary": {
      "type": "object",
      "required": ["passed", "failed", "skipped", "total_clusters"],
      "properties": {
        "passed": { "type": "integer" },
        "failed": { "type": "integer" },
        "skipped": { "type": "integer" },
        "total_clusters": { "type": "integer" }
      }
    },
    "delta": {
      "type": "object",
      "properties": {
        "newly_passing": { "type": "integer" },
        "newly_broken_regressions": { "type": "integer" },
        "still_failing": { "type": "integer" }
      }
    },
    "clusters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["cluster_id", "fingerprint", "error_kind", "affected_count", "sample_tests", "message", "top_frame", "signal_window"],
        "properties": {
          "cluster_id": { "type": "string" },
          "fingerprint": { "type": "string" },
          "error_kind": {
            "type": "string",
            "enum": ["ASSERTION_FAILURE", "RUNTIME_EXCEPTION", "TYPE_COMPILE_ERROR", "SYNTAX_IMPORT_ERROR", "TIMEOUT_OR_CONN_REFUSED", "UNSTRUCTURED_BUILD_ERROR"]
          },
          "affected_count": { "type": "integer" },
          "sample_tests": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
          "diff": {
            "type": "object",
            "properties": {
              "expected": { "type": "string" },
              "received": { "type": "string" }
            }
          },
          "message": { "type": "string" },
          "top_frame": { "type": "string", "description": "Repository relative file:line:col" },
          "pruned_stack": { "type": "array", "items": { "type": "string" }, "maxItems": 6, "description": "At most 5 repository frames plus 1 external boundary frame (INV-4), in original order" },
          "signal_window": { "type": "string", "description": "Inlined +/-context-lines (default 2) of source code around top_frame; the failing line is marked with '>'; empty string when the file cannot be read" },
          "raw_log_lines": { "type": "string", "description": "Line range in raw_log_path (e.g., 'L412-L448')" }
        }
      }
    },
    "raw_log_path": { "type": "string" }
  }
}
```

#### 4.1.1. Output Formats & Ceiling Rules

| Format | Payload | Ceiling |
| :--- | :--- | :--- |
| `compact-md` (default) | One line on `PASS`/`VALID_RED`; one clustered body on every other status | `INV-1` (`160 bytes`) / `INV-2` (`600 EstimatedToken`) |
| `json` | The complete envelope of §4.1, pretty-printed and newline-terminated | Not byte-bounded; truncating it would break its consumer |

`INV-1` and `INV-2` bind `compact-md` only: a conforming JSON envelope cannot fit in 160 bytes, so exempting JSON is the only self-consistent reading. The raw log path is shortened to `~/…` before the pass line is measured. The status word for a satisfied green phase is `PASS` — there is no `VALID_GREEN` status.

#### Scenario 1: Clean Green Pass (`INV-1` Enforcement)
* **GIVEN** a test suite with 240 passing tests across 32 files that emits 1,800 lines of terminal checkmarks and `console.log` output
* **WHEN** `dot-test-digest --tdd-phase=green -- vitest run` executes and all 240 tests pass
* **THEN** the runtime SHALL persist the full output to `~/.cache/dot-test-digest/logs/<run_id>.log`, exit with code `0`, and emit only a single compact line (`<= 35 tokens`) to `stdout`:
  `[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: ~/.cache/dot-test-digest/logs/run_8f2a.log`

### 4.2. Requirement: Gear 0 Grammar Adapters, Stack Pruner & SignalWindow Inliner (`REQ-GEAR0-ENGINE`)

Before invoking any external classifier, Gear 0 SHALL strip all ANSI CSI/OSC sequences (`\x1b\[[0-9;]*[a-zA-Z]`), collapse carriage-return progress overwrites **within** a line (keeping the last segment that still has visible text, so a CRLF terminator never erases the line), and drop passing noise. Line identity is preserved 1:1 so that every `raw_log_lines` pointer stays valid. Gear 0 then parses the stream using its deterministic grammar adapters:

1. **JavaScript / TypeScript Test Runners (`vitest`, `jest`, `playwright`, `node --test`)**: Extracts `Expected` vs. `Received` diffs, assertion types, and `at <symbol> (<file>:<line>:<col>)` stack frames. TAP (`not ok N - …` with `# tests`/`# pass`/`# fail`) and Playwright's numbered `N) [browser] › …` headers are part of this grammar. When the child is piped — the normal case, since the wrapper always captures `stdout`/`stderr` — the compact (non-TTY) reporter forms of §4.2.1 also apply.
2. **TypeScript & Linters (`tsc`, `eslint`, `biome`)**: Parses `file(line,col): error TSXXXX: message` diagnostics and groups identical error codes occurring on the same symbol or type definition into a single `FailureCluster`.
3. **Python (`pytest`, `ruff`, `mypy`)**: Parses `E   AssertionError` diffs and `file:line: in <func>` traceback entries, stripping `.venv/` and `site-packages/` frames.
4. **Rust & Go (`cargo test`, `cargo check`, `go test`)**: Parses `thread '...' panicked at file:line:col` and `rustc` diagnostic spans (`--> file:line:col`), stripping `/rustc/` and Go runtime frames.

For every deduplicated `FailureCluster`, the `SignalWindow` Inliner SHALL read the repository file referenced in `top_frame` from disk and attach `--context-lines` lines around the target line number (default ±2, marking the exact line with `>`) so the caller immediately sees the offending source lines without opening the file separately.

#### 4.2.1. Piped (Non-TTY) Runner Output

When the child's `stdout`/`stderr` are pipes — the normal case for this wrapper — the JavaScript / TypeScript adapter MUST additionally recognize the compact reporter forms:

a. A file banner `❯ <file> (<n> tests | <m> failed) <duration>` is **metadata**. It MUST NOT create a `FailureCluster`, MUST NOT be recorded as a stack frame, and MUST NOT terminate the raw-line range of the failures that follow it.
b. An inline failing row `× <name> <duration>` (or `✕`/`✗`) MUST have the trailing duration removed before `<name>` is used as a test identifier. Durations are presentation, never identity.
c. A continuation row `→ <message>` MUST be stored as the failure message.
d. The `Failed Tests <n>` summary and its `FAIL <file> > <name>` rows describe failures that were already listed inline. They MUST be reconciled with the inline rows, not counted again.
e. A stack printed once for a deduplicated group of summary rows MUST be attributed to every row in that group, so each member carries the same frames for fingerprinting, pruning and `top_frame`.
f. Separators and counters (`[1/50]`, `Test Files …`, `Tests …`, `Duration …`) MUST never become frames, messages or failures.

A `Failed Suites` block (for example, a broken import) is not an inline-failure grammar; it retains the v0.1.1 grammar so that its `SYNTAX_IMPORT_ERROR` classification and failure block survive.

#### 4.2.2. Failure Reconciliation and Accounting

For a given run, after all sources in the stream have been parsed, the runtime MUST emit **at most one** failure record per canonical test identity (§4.3). Consequently:

* `affected_count` MUST count distinct tests, not parse records, and `Σ affected_count` over all deduplicated clusters MUST equal the number of distinct parsed failures — and therefore equal `summary.failed` when no cluster is dropped by `--max-clusters` or the `INV-2` budget;
* a grammar-parsed run MUST NOT report more failures than the runner's own summary (`Σ affected_count <= summary.failed` in every case);
* only actual stack-frame lines MAY enter `pruned_stack`; banners, messages, separators and counters MUST be rejected by frame validation;
* when no repository frame exists in the captured text, `top_frame` MUST be `unknown:0:0`, `signal_window` MUST be empty, and the runtime MUST report that honestly rather than invent a file or borrow the test file's name.

#### Scenario 2: Cascading Failure Deduplication (`INV-2` & `INV-4` Enforcement)
* **GIVEN** a broken helper `parseToken()` in `src/auth/jwt.ts:28` causes 47 integration tests across 8 test files to throw `TypeError: token.split is not a function at parseToken (src/auth/jwt.ts:28:19)` with 35 lines of `node_modules/vitest/...` frames per test (1,900+ lines of raw output)
* **WHEN** `dot-test-digest` processes the failed stream
* **THEN** Gear 0 SHALL compute the `RootCauseFingerprint` (`SHA256("RUNTIME_EXCEPTION|src/auth/jwt.ts:28|TypeError: *.split is not a function")`), collapse all 47 failures into **1 `FailureCluster`** with `affected_count: 47`, strip all 35 `node_modules` frames per test, inline lines `26–30` of `src/auth/jwt.ts`, and emit `< 180 tokens` total to `stdout`.

### 4.3. Requirement: TDD Red-Green-Refactor Phase Gate (`REQ-TDD-GATE`)

When `--tdd-phase` is specified, `dot-test-digest` SHALL persist run state at `${DOT_TEST_DIGEST_HOME:-~/.cache/dot-test-digest}/state-<scope_id>.json`, written atomically (unique temp file, then rename) so concurrent scopes never contend, and enforce the following phase transition rules:

Baseline entries and `RedGreenDelta` MUST use a canonical identity of the form `<repo-relative test file>::<test name>`, derived from the summary-section row (which carries the file) or from the preceding file banner plus the inline row. ANSI, timing suffixes, and duplicate representations of the same test MUST be removed before comparison. `newly_passing`, `still_failing` and `newly_broken_regressions` MUST count distinct identities. A single test that appears twice in one run's text contributes one identity and one count.

| `--tdd-phase` | Child Exit Code | Error Kind Detected | Gate Verdict | Exit Code & Action |
| :--- | :--- | :--- | :--- | :--- |
| **`red`** | `0` (All Pass) | None | **`INVALID_RED`** | Exits `64`; reports: *"New test passed before implementation; expected a failing behavioral assertion."* |
| **`red`** | `!= 0` | `SYNTAX_IMPORT_ERROR` (e.g. `SyntaxError`, `Cannot find module`, `TS2307`, `Failed to load url`) | **`INVALID_RED`** | Exits `64`; reports: *"Test failed due to syntax or unresolved module import rather than a behavioral assertion."* |
| **`red`** | `!= 0` | `ASSERTION_FAILURE`, `RUNTIME_EXCEPTION`, or a missing exported symbol under test | **`VALID_RED`** | Records baseline failing test identifiers in `state-<scope_id>.json`; exits `0`. |
| **`red`** | `!= 0` | No failure block and no behavioral evidence in the log | **`INVALID_RED`** | Exits `64`; reports: *"Test run failed before any test executed (runner startup crash or no tests collected)."* |
| **`green`** | `0` (All Pass) | None | **`PASS`** | Verifies previously recorded failing test identifiers now pass; exits `0`. |
| **`green`** | `!= 0` | Any failure | **`FAIL`** | Exits with the child's exit code; `RedGreenDelta` is populated. A re-broken baseline test surfaces as `newly_broken_regressions`. |
| **`refactor`** | `0` (All Pass) | None | **`PASS`** | Exits `0`. |
| **`refactor`** | `!= 0` | Any failure | **`REGRESSION_DETECTED`** | Emits `newly_broken_regressions` diff; exits with the child process's non-zero exit code. |
| **`none`** | `0` | — | **`PASS`** | Exits `0`. |
| **`none`** | `!= 0` | A grammar adapter produced a cluster | **`FAIL`** | Exits with the child's exit code. |
| **`none`** | `!= 0` | No grammar cluster (Gear 1 or heuristic fallback) | **`BUILD_ERROR`** | Exits with the child's exit code. |

`VALID_RED` is deliberately distinct from `FAIL`: the red phase is a *successful* gate run, and collapsing the two would make the envelope ambiguous for anything reading it. `BUILD_ERROR` is the unstructured analogue — no grammar produced a cluster.

#### Scenario 3: Blocking a Broken Import During the RED Phase (`INV-5` Enforcement)
* **GIVEN** a test file `tests/discount.spec.ts` contains a typo in an import path (`import { makeCart } from './helprs'`)
* **WHEN** `dot-test-digest --tdd-phase=red -- vitest run tests/discount.spec.ts` executes and `vitest` exits with code `1` (`Error: Failed to resolve import "./helprs"`)
* **THEN** `dot-test-digest` SHALL classify `error_kind` as `SYNTAX_IMPORT_ERROR`, emit `status: "INVALID_RED"`, and exit with code `64`.

### 4.4. Requirement: Gear 1 System-1 Jev Unstructured Log Triage (`REQ-GEAR1-JEV`)

When a wrapped command exits with `exit_code != 0`, produces more than 150 lines of combined `stdout`/`stderr`, and yields zero `FailureCluster` records — **regardless of whether an adapter matched** — the runtime SHALL escalate to **Gear 1 (System-1 Jev Autopilot)**. This covers `nix build`, `docker build`, CMake/C++ linker errors, custom shell scripts, and also runners whose output a grammar matched without producing a failure block (a startup crash, an unsupported reporter). Runs of 150 lines or fewer go straight to the heuristic fallback.

1. **Candidate Window Partitioning (`INV-6`)**: The unstructured stream is partitioned into overlapping 12-line windows filtered by failure salience tokens (`error`, `fatal`, `failed`, `panic`, `undefined reference`, `permission denied`, `enoent`, `exit status`, `traceback`, `exception`). If more than 252 windows match, the runtime retains the 252 highest-salience windows plus the final 3 tail windows (`<= 255` total candidate options).
2. **Single-Pass Multi-Question Jev Request**: Dispatches a single RPC call — `POST {TYPESAFE_API_URL:-https://api.typesafe.ai}/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{ "model": "jev-1.13.0", "state": …, "questions": … }` — bundling three questions. `questions` is a **map keyed by caller-chosen id**, every `type` is lowercase, and a `choice` question's `criteria` is a **map of option name → description** (at most 255 keys):
   * `root_cause_window` (`type: "choice"`, `<= 255` options): Selects the window id containing the primary root cause, ignoring downstream cascading wrapper errors such as `make: *** [all] Error 2`.
   * `error_category` (`type: "choice"`): Selects from `["COMPILE_OR_LINK_ERROR", "MISSING_DEPENDENCY_OR_PACKAGE", "ENV_OR_PORT_COLLISION", "PERMISSION_OR_SECRET_MISSING", "TRANSIENT_NETWORK_OR_TIMEOUT"]`.
   * `is_transient_flake` (`type: "noul"`): Evaluates *"Is this failure caused by a transient network timeout, port lock, or race condition that warrants one automatic retry?"* and answers with the probability that the answer is yes, in `answers.is_transient_flake.noul`. A `noul` has **no** `confidence` field.

   `state` MUST be bounded: the command line, the exit code, the total line count, and at most the last 40 lines. Candidate window text travels in `criteria`, and the serialized request MUST be budgeted to fit the 64k-token context (INV-6).
3. **Probability Gate & Auto-Retry**: If `answers.is_transient_flake.noul >= 0.80` (`FLAKE_PROBABILITY_THRESHOLD`) and `--retry-flakes` is enabled, `dot-test-digest` re-runs the command **at most once** before reporting. Otherwise it wraps the selected window plus ±10 surrounding log lines into a `FailureCluster` (`execution_gear: "GEAR_1_JEV"`, `error_kind: "UNSTRUCTURED_BUILD_ERROR"`, repository-relative `top_frame`, raw log line pointer). If the key is missing, `--no-jev` is set, the call fails, or it times out, the runtime MUST fall back to the most salient window and report `execution_gear: "GEAR_0_HEURISTIC_FALLBACK"`.

#### Scenario 4: Pinpointing Root Cause in a 3,000-Line Unstructured Build Log
* **GIVEN** `dot-test-digest -- cargo build` fails after emitting 3,200 lines of compiler and native linker output where the root error (`ld: library not found for -lpq` on line 2,840) is followed by 360 lines of cascading build-script abort messages
* **WHEN** Gear 0 finds no test-runner grammar match and passes 84 candidate error windows to Gear 1 (Jev)
* **THEN** Jev selects window `w_61` (`lines 2835–2847`) with `error_category = "MISSING_DEPENDENCY_OR_PACKAGE"`, and `dot-test-digest` emits only that window and its raw log line pointer (`L2835-L2847`) to `stdout`, after exactly one RPC call. The `< 150ms` figure in CT-4 is a property of the Jev service, not of this binary; the compliance test asserts the single round trip and the `<= 255` option count, which are what this repository controls.

## 5. Repository & Module Layout (`SPEC-LAYOUT`)

To keep the codebase modular and self-contained, the implementation SHALL follow this directory layout:

| File Path | Module Responsibility |
| :--- | :--- |
| `package.json` | Package manifest (`dot-test-digest`) with minimal runtime dependencies (`zod` and native `node:child_process`). |
| `tsconfig.json` | Strict TypeScript `5.x` compiler configuration targeting Node.js `>= 20.x`. |
| `specs/SPEC-002-DOT-TEST-DIGEST.md` | Architecture and behavioral contract specification. |
| `src/index.ts` | CLI entrypoint parsing flags, spawning child processes with pipe capture, and returning transparent exit codes (`INV-3`). |
| `src/pruner/ansi-stripper.ts` | Streaming stripper for ANSI CSI/OSC sequences, spinner carriage-returns, and passing test noise (`INV-1`). |
| `src/pruner/stack-pruner.ts` | Strips `node_modules`, `/nix/store`, `.venv`, and stdlib frames (`INV-4`) and reads ±2-line `SignalWindow` snippets from disk. |
| `src/pruner/cluster-dedup.ts` | Computes `RootCauseFingerprint` hashes and collapses cascading failures into bounded `FailureCluster` records (`INV-2`). |
| `src/pruner/failure-identity.ts` | Canonical test identity (normalisation, `file::name` keys, deduplication) shared by the adapters, the pruner and the TDD gate (§4.2.2, §4.3). |
| `src/adapters/index.ts` | Gear 0 deterministic grammar parsers for `vitest`/`jest`, `tsc`/`eslint`, `pytest`/`ruff`, and `cargo`/`go test`. |
| `src/gears/gear1-jev.ts` | Unstructured log window chunker (`<= 255` options, budgeted request `INV-6`), multi-question assembly, and transient flake retry trigger. |
| `src/state/tdd-gate.ts` | Manages `${DOT_TEST_DIGEST_HOME:-~/.cache/dot-test-digest}/state-<scope_id>.json`, enforces `INV-5` (`VALID_RED` vs `INVALID_RED`), and computes `RedGreenDelta`. |
| `src/formatters/envelope.ts` | Serializes `DigestEnvelope` into compact Markdown (`--format=compact-md`) or JSON (`--format=json`). |
| `src/types/schema.ts` | Zod schemas for CLI flags, `DigestEnvelope`, `FailureCluster`, and Jev API payloads. |
| `tests/pruner.spec.ts` | Unit tests verifying ANSI stripping, stack frame pruning (`INV-4`), and `SignalWindow` source extraction. |
| `tests/dedup-and-tdd.spec.ts` | Behavioral tests verifying 50-to-1 cascade deduplication (`INV-2`) and `--tdd-phase=red` validation (`INV-5`). |
| `tests/gear1-jev.spec.ts` | Tests verifying `<= 255` candidate window partitioning (`INV-6`) and Jev unstructured build log classification. |
| `src/cli/args.ts` | Flag parsing, `USAGE`, and `UsageError` (`64`). |
| `src/adapters/common.ts` | Shared adapter types, `error_kind` classification, and count parsing. |
| `src/runner/capture.ts` | Child spawn, line-numbered tee, exit/signal mapping (`INV-3`). |
| `src/runner/raw-log.ts` | Run id, cache root (`DOT_TEST_DIGEST_HOME`), line-range formatting. |
| `src/gears/windows.ts` | 12-line window partitioner and `<= 255` selection (`INV-6`). |
| `src/gears/jev-client.ts` | Jev 1.13 HTTP client (`POST /v1/systemone`). |
| `tests/cli.spec.ts` | Exit-code transparency (`INV-3`), usage errors, and the pass-state ceiling. |
| `tests/adapters.spec.ts` | Grammar coverage across all four adapter families. |
| `tests/fixtures/**` | Generated logs and the fixture project used by CT-1…CT-3. |
| `vitest.config.ts`, `.env.example`, `README.md` | Test config, environment template, operator docs. |

The table is the minimum contract: every listed path MUST exist with its stated responsibility. Additive modules are permitted, provided none of the rows above loses its responsibility to them.

## 6. Acceptance Criteria & Definition of Done (`v0.1.2`)

* **Compliance Test 1 (`CT-1`: Pass-State Compression)**: Wrapping a passing test suite that emits `2,500 lines` (`~18,000 tokens`) of standard `vitest` + `console.log` output MUST emit `<= 160 bytes` **including the trailing newline** to `stdout` in `compact-md` (`>= 99.8%` token reduction) while preserving the full `2,500 lines` in `~/.cache/dot-test-digest/logs/<run_id>.log`.
* **Compliance Test 2 (`CT-2`: 50-to-1 Cascade Deduplication & Stack Pruning, end-to-end)**: Generate a fixture in which 50 tests across 10 files fail because a shared **repository** helper performs the failing operation (so the throw site is a repository frame and the printed stack may also contain external frames). Run the built binary as `dot-test-digest -- vitest run` with `stdout` piped (non-TTY). The emitted `compact-md` output MUST contain exactly `1` `FailureCluster` with `affected_count: 50`, **no** internal or third-party frames other than at most one external boundary frame (as permitted by `INV-4`), and an inlined 5-line `SignalWindow` from the helper file. Total `stdout` MUST be `<= 220 EstimatedToken`; the universal ceiling remains `INV-2`'s 600. The JSON envelope MUST report `summary.failed: 50`, `total_clusters: 1`, and `Σ affected_count = 50`. V8 prints at most 10 frames by default, so the fixture MUST place the throwing repository frame inside that window; a stack containing only `node_modules` frames does not require a `SignalWindow`, and §4.2.2's honesty rule applies instead.
* **Compliance Test 3 (`CT-3`: TDD Invalid-Red Gate Enforcement)**: Running `dot-test-digest --tdd-phase=red` against (a) a passing test file and (b) a test file containing an unresolved `import` or `SyntaxError` MUST in both cases emit `status: "INVALID_RED"` and exit with code `64`; running it against a test file that fails on `expect(actual).toBe(expected)` MUST emit `status: "VALID_RED"` and exit with code `0`.
* **Compliance Test 4 (`CT-4`: Gear 1 Jev Unstructured Build Pinpointing)**: Feeding a `3,000-line` unstructured linker failure fixture (where the actual linker error occurs 400 lines above the end of the log) with Jev (`jev-1.13.0+`) MUST send `<= 255` candidate windows in **exactly one** RPC call to `/v1/systemone` and return a `FailureCluster` containing the exact linker error window. Service latency (`< 150ms`) is a property of Jev, not of this binary, and is not asserted here.
* **Compliance Test 5 (`CT-5`: Concurrent Scope Isolation)**: Running two concurrent `dot-test-digest` processes with `--scope-id=s01` and `--scope-id=s02` (with `DOT_TEST_DIGEST_HOME` pointing at a temp directory) MUST write isolated state files (`state-s01.json`, `state-s02.json`), leave no `.tmp` residue, and show zero file lock contention or cross-run `RedGreenDelta` contamination.
* **Compliance Test 6 (`CT-6`: Exit-Code Transparency, `INV-3`)**: Wrapping a child that exits `42`, a child killed by `SIGTERM`, a command that does not exist, and an unknown flag MUST yield `42`, `143`, `127` and `64` respectively, with the digest on `stdout` and diagnostics on `stderr`.

## 7. Revision History

| Version | Date | Change |
| :--- | :--- | :--- |
| `0.1.2` | 2026-10-31 | Applies `specs/DELTA-SPEC-002-0.1.2.md` after the first acceptance run (`17 PASS / 0 FAIL / 1 SKIP`). Adds §4.2.1 (piped non-TTY runner grammar) and §4.2.2 (one failure per canonical identity, frame validation, honest `unknown:0:0`); adds canonical `file::name` identity to §4.3 so duplicate reporter sections cannot inflate `RedGreenDelta`; rewrites `CT-2` as an end-to-end piped CLI test whose repository throw site is inside V8's 10-frame window and aligns its `node_modules` wording with `INV-4`'s single boundary frame. No invariant or ceiling is relaxed. |
| `0.1.1` | 2026-10-30 | Applies the integrity review (`specs/INTEGRITY-SPEC-002.md`). `VALID_RED` added to the status enum and `VALID_GREEN` corrected to `PASS`; `--retry-flakes`, `--help`, `--version` documented; `pruned_stack` widened to 6 and engine frames excluded; the Jev wire contract corrected to `POST /v1/systemone` with lowercase types, a question map and a `criteria` map; `noul` probability replaces `confidence`; escalation widened to `clusters.length == 0` regardless of adapter match; the green failure row, `BUILD_ERROR` assignment and all `none` rows added; the red gate gains the missing-export rule and the behavioral-evidence rule; truncation policy and the `compact-md`-only scope of `INV-1`/`INV-2` stated; `state` bounded; `CT-6` added; editorial fixes (`±` notation, `Date`/`Depends on` header, layout rows completed). |
| `0.1.0` | 2026-10-30 | Initial draft. |
