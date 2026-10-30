# Specification: `dot-test-digest` (Three-Gear Test, Compiler & Build Output Compressor)

| Field | Value |
| :--- | :--- |
| **Spec ID** | `SPEC-002-DOT-TEST-DIGEST` |
| **Status** | `DRAFT` |
| **Version** | `0.1.0` |
| **Target Runtime** | Node.js `>= 20.x` / TypeScript `5.x` |
| **Upstream Dependency** | `zod`, TypeSafe AI Jev API (`jev-1.13.0+`) |

## 1. Normative Language & Terminology

The key words **"MUST"**, **"MUST NOT"**, **"REQUIRED"**, **"SHALL"**, **"SHALL NOT"**, **"SHOULD"**, **"SHOULD NOT"**, **"RECOMMENDED"**, **"MAY"**, and **"OPTIONAL"** in this document are to be interpreted as described in RFC 2119.

| Term | Definition |
| :--- | :--- |
| **`DigestEnvelope`** | The bounded JSON or compact Markdown payload emitted to `stdout` (`<= 35 tokens` on pass, `<= 600 tokens` on failure). |
| **`FailureCluster`** | A deduplicated group of one or more failing tests or compiler diagnostics that share an identical `RootCauseFingerprint`. |
| **`RootCauseFingerprint`** | A deterministic hash `SHA256(error_kind + top_repo_frame_location + normalized_assertion_template)` used to collapse cascading failures into a single `FailureCluster`. |
| **`StackFramePruner`** | The Gear 0 filter that strips runtime internals and third-party dependency frames (`node_modules/`, `/nix/store/`, `.venv/`, stdlib) while preserving repository frames. |
| **`SignalWindow`** | A $\pm 2$-line slice of repository source code read directly from disk around the top failing `file:line` frame and inlined into the `FailureCluster`. |
| **`TddPhaseGate`** | The state machine (`red`, `green`, `refactor`) that validates whether a test execution outcome satisfies the requested test-driven development phase transition. |
| **`RedGreenDelta`** | The stateful diff comparing the current test execution against the prior run's persisted state (`newly_passing`, `newly_broken_regressions`, `still_failing`). |

## 2. Purpose & System Scope

Standard test runners (`vitest`, `jest`, `pytest`, `cargo test`, `go test`, `playwright test`) and build or static-analysis tools (`tsc`, `eslint`, `ruff`, `nix build`) format their output for human terminal scrolling rather than bounded context consumption. A single test execution frequently emits ANSI escape sequences, progress spinners, thousands of lines of passing test checkmarks, verbose `console.log` debugging output, 40-frame deep `node_modules` stack traces, and 50 identical failure blocks when a single shared function throws an exception.

`dot-test-digest` SHALL operate as a drop-in, exit-code-transparent CLI wrapper (`dot-test-digest [flags] -- <command>`) that intercepts child process `stdout` and `stderr` streams and resolves them locally through a **Three-Gear Execution Hierarchy**:

1. **Gear 0 (Deterministic Grammar Parser, Stack Pruner & Deduplicator)**: Zero-token, `<15ms` local stream processing that strips ANSI/passing noise, parses structured runner outputs (`vitest`, `jest`, `pytest`, `cargo`, `go`, `tsc`), collapses cascading failures into deduplicated `FailureCluster` records, strips third-party stack frames, and inlines the 5-line `SignalWindow` from the local source file.
2. **Gear 1 (System-1 Jev Fault Classifier for Unstructured Build Logs)**: Sub-120ms discriminative log triage via the Jev API (`jev-1.13.0+`), invoked **only** when a command fails with $>150$ lines of unstructured output (such as raw `nix build`, `docker build`, C++/Rust linker dumps, or database migration crashes) that no Gear 0 grammar adapter matches.
3. **Gear 2 (Bounded Output Delivery & Raw Byte-Range Pointer)**: Emits the compact `DigestEnvelope` to `stdout` while persisting the unedited raw stream to `~/.cache/dot-test-digest/logs/<run_id>.log` so callers can inspect specific byte or line ranges on demand only when deeper forensics are required.

## 3. Architectural Invariants (Non-Negotiable Rules)

* **`INV-1` (Pass-State Token Ceiling)**: When the wrapped command exits with code `0` (and satisfies the active `TddPhaseGate`), `dot-test-digest` MUST NOT emit more than `160 bytes` (`<= 35 tokens`) to `stdout`. All passing test names, compiler banners, deprecation warnings, and `stdout` logs MUST be suppressed.
* **`INV-2` (Fail-State Token Ceiling & Cascade Deduplication)**: When multiple tests fail with the same `RootCauseFingerprint`, the runtime MUST collapse them into a single `FailureCluster` showing the stack trace and `SignalWindow` exactly once, accompanied by `affected_count` and at most 3 sample test names. Total `stdout` emitted on a failed run MUST NOT exceed `600 tokens` (`max_clusters` default: `5`).
* **`INV-3` (Strict Exit-Code Transparency)**: Except when explicitly blocking an invalid TDD phase transition under `INV-5`, `dot-test-digest` MUST exit with the exact integer exit code (`0..255`) or POSIX signal termination code of the underlying child process.
* **`INV-4` (Zero Third-Party Stack Pollution)**: Emitted stack traces MUST strip all frames originating from language internals or external package directories (`node:internal/*`, `node_modules/*`, `/nix/store/*`, `.venv/*`, `site-packages/*`, `/usr/lib/*`, Go/Rust stdlib), retaining at most 1 external boundary frame (the exact third-party function called by repository code) and up to 5 internal repository frames.
* **`INV-5` (TDD Red-Phase Behavioral Gate)**: When invoked with `--tdd-phase=red`, the run is valid **if and only if** the child process fails (`exit_code != 0`) due to a behavioral test assertion failure or missing exported symbol under test. If the command passes (`exit_code == 0`) OR fails due to a syntax error, broken test import path, or test-runner startup crash, `dot-test-digest` MUST emit `status: "INVALID_RED"` and exit with code `64` (`EX_USAGE`).
* **`INV-6` (Strict Option Ceiling for Gear 1 Jev)**: Any unstructured log triage payload dispatched to the Jev API in Gear 1 MUST NOT exceed `255` candidate log-window options in a single `Choice` question.

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
| `--scope-id` | `string` (auto-hashed from working directory path) | Scopes `~/.cache/dot-test-digest/state-<scope_id>.json` so concurrent runs in separate directories never collide. |
| `--no-jev` | `boolean` (`false`) | Disables Gear 1 Jev API fallback for offline execution, falling back to heuristic tail extraction. |

**`DigestEnvelope` Output Schema (`--format=json`)**:

```json
{
  "type": "object",
  "required": ["status", "exit_code", "execution_gear", "duration_ms", "summary", "raw_log_path"],
  "properties": {
    "status": {
      "type": "string",
      "enum": ["PASS", "FAIL", "INVALID_RED", "REGRESSION_DETECTED", "BUILD_ERROR"]
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
          "pruned_stack": { "type": "array", "items": { "type": "string" }, "maxItems": 5 },
          "signal_window": { "type": "string", "description": "Inlined +/-2 lines of source code around top_frame" },
          "raw_log_lines": { "type": "string", "description": "Line range in raw_log_path (e.g., 'L412-L448')" }
        }
      }
    },
    "raw_log_path": { "type": "string" }
  }
}
```

#### Scenario 1: Clean Green Pass (`INV-1` Enforcement)
* **GIVEN** a test suite with 240 passing tests across 32 files that emits 1,800 lines of terminal checkmarks and `console.log` output
* **WHEN** `dot-test-digest --tdd-phase=green -- vitest run` executes and all 240 tests pass
* **THEN** the runtime SHALL persist the full output to `~/.cache/dot-test-digest/logs/<run_id>.log`, exit with code `0`, and emit only a single compact line (`<= 35 tokens`) to `stdout`:
  `[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: ~/.cache/dot-test-digest/logs/run_8f2a.log`

### 4.2. Requirement: Gear 0 Grammar Adapters, Stack Pruner & SignalWindow Inliner (`REQ-GEAR0-ENGINE`)

Before invoking any external classifier, Gear 0 SHALL strip all ANSI CSI/OSC sequences (`\x1b\[[0-9;]*[a-zA-Z]`), carriage-return progress overwrites (`\r`), and redundant blank lines, then parse the stream using its deterministic grammar adapters:

1. **JavaScript / TypeScript Test Runners (`vitest`, `jest`, `playwright`, `node --test`)**: Extracts `Expected` vs. `Received` diffs, assertion types, and `at <symbol> (<file>:<line>:<col>)` stack frames.
2. **TypeScript & Linters (`tsc`, `eslint`, `biome`)**: Parses `file(line,col): error TSXXXX: message` diagnostics and groups identical error codes occurring on the same symbol or type definition into a single `FailureCluster`.
3. **Python (`pytest`, `ruff`, `mypy`)**: Parses `E   AssertionError` diffs and `file:line: in <func>` traceback entries, stripping `.venv/` and `site-packages/` frames.
4. **Rust & Go (`cargo test`, `cargo check`, `go test`)**: Parses `thread '...' panicked at file:line:col` and `rustc` diagnostic spans (`--> file:line:col`), stripping `/rustc/` and Go runtime frames.

For every deduplicated `FailureCluster`, the `SignalWindow` Inliner SHALL read the repository file referenced in `top_frame` from disk and attach $\pm 2$ lines around the target line number (marking the exact line with `>`) so the caller immediately sees the offending source lines without opening the file separately.

#### Scenario 2: Cascading Failure Deduplication (`INV-2` & `INV-4` Enforcement)
* **GIVEN** a broken helper `parseToken()` in `src/auth/jwt.ts:28` causes 47 integration tests across 8 test files to throw `TypeError: token.split is not a function at parseToken (src/auth/jwt.ts:28:19)` with 35 lines of `node_modules/vitest/...` frames per test (1,900+ lines of raw output)
* **WHEN** `dot-test-digest` processes the failed stream
* **THEN** Gear 0 SHALL compute the `RootCauseFingerprint` (`SHA256("RUNTIME_EXCEPTION|src/auth/jwt.ts:28|TypeError: *.split is not a function")`), collapse all 47 failures into **1 `FailureCluster`** with `affected_count: 47`, strip all 35 `node_modules` frames per test, inline lines `26–30` of `src/auth/jwt.ts`, and emit `< 180 tokens` total to `stdout`.

### 4.3. Requirement: TDD Red-Green-Refactor Phase Gate (`REQ-TDD-GATE`)

When `--tdd-phase` is specified, `dot-test-digest` SHALL persist run state at `~/.cache/dot-test-digest/state-<scope_id>.json` and enforce the following phase transition rules:

| `--tdd-phase` | Child Exit Code | Error Kind Detected | Gate Verdict | Exit Code & Action |
| :--- | :--- | :--- | :--- | :--- |
| **`red`** | `0` (All Pass) | None | **`INVALID_RED`** | Exits `64`; reports: *"New test passed before implementation; expected a failing behavioral assertion."* |
| **`red`** | `!= 0` | `SYNTAX_IMPORT_ERROR` (e.g., `SyntaxError`, `Cannot find module`, `TS2307`) | **`INVALID_RED`** | Exits `64`; reports: *"Test failed due to syntax or unresolved module import rather than a behavioral assertion."* |
| **`red`** | `!= 0` | `ASSERTION_FAILURE`, `RUNTIME_EXCEPTION`, or missing target symbol | **`VALID_RED`** | Records baseline failing test identifiers in `state-<scope_id>.json`; exits `0`. |
| **`green`** | `0` (All Pass) | None | **`VALID_GREEN`** | Verifies previously recorded failing test identifiers now pass; exits `0`. |
| **`refactor`** | `!= 0` | Any failure | **`REGRESSION_DETECTED`** | Emits `newly_broken_regressions` diff; exits with the child process's non-zero exit code. |

#### Scenario 3: Blocking a Broken Import During the RED Phase (`INV-5` Enforcement)
* **GIVEN** a test file `tests/discount.spec.ts` contains a typo in an import path (`import { makeCart } from './helprs'`)
* **WHEN** `dot-test-digest --tdd-phase=red -- vitest run tests/discount.spec.ts` executes and `vitest` exits with code `1` (`Error: Failed to resolve import "./helprs"`)
* **THEN** `dot-test-digest` SHALL classify `error_kind` as `SYNTAX_IMPORT_ERROR`, emit `status: "INVALID_RED"`, and exit with code `64`.

### 4.4. Requirement: Gear 1 System-1 Jev Unstructured Log Triage (`REQ-GEAR1-JEV`)

When a wrapped command exits with `exit_code != 0`, produces $> 150$ lines of combined `stdout`/`stderr`, and yields zero structured `FailureCluster` matches across Gear 0 grammar adapters (such as `nix build`, `docker build`, CMake/C++ linker errors, or custom shell scripts), the runtime SHALL escalate to **Gear 1 (System-1 Jev Autopilot)**:

1. **Candidate Window Partitioning (`INV-6`)**: The unstructured stream is partitioned into overlapping 12-line windows filtered by failure salience tokens (`error`, `fatal`, `failed`, `panic`, `undefined reference`, `permission denied`, `enoent`, `exit status`, `traceback`, `exception`). If $> 252$ windows match, the runtime retains the 252 highest-salience windows plus the final 3 tail windows (`<= 255` total candidate options).
2. **Single-Pass Multi-Question Jev Request**: Dispatches a single RPC call (`POST /v1/jev`) bundling three questions:
   * `root_cause_window` (`type: "Choice"`, `<= 255` options): Selects the window ID containing the primary root cause (ignoring downstream cascading wrapper errors such as `make: *** [all] Error 2`).
   * `error_category` (`type: "Choice"`): Selects from `["COMPILE_OR_LINK_ERROR", "MISSING_DEPENDENCY_OR_PACKAGE", "ENV_OR_PORT_COLLISION", "PERMISSION_OR_SECRET_MISSING", "TRANSIENT_NETWORK_OR_TIMEOUT"]`.
   * `is_transient_flake` (`type: "Noul"`): Evaluates *"Is this failure caused by a transient network timeout, port lock, or race condition that warrants one automatic retry?"*
3. **Confidence Gate & Auto-Retry**: If `is_transient_flake == true` with confidence `>= 0.80` (and `--retry-flakes` is enabled), `dot-test-digest` re-runs the command once automatically before reporting failure. Otherwise, it wraps the selected `root_cause_window` (plus $\pm 10$ surrounding log lines) into a `FailureCluster` with `execution_gear: "GEAR_1_JEV"`.

#### Scenario 4: Pinpointing Root Cause in a 3,000-Line Unstructured Build Log
* **GIVEN** `dot-test-digest -- cargo build` fails after emitting 3,200 lines of compiler and native linker output where the root error (`ld: library not found for -lpq` on line 2,840) is followed by 360 lines of cascading build-script abort messages
* **WHEN** Gear 0 finds no test-runner grammar match and passes 84 candidate error windows to Gear 1 (Jev)
* **THEN** Jev selects window `w_61` (`lines 2835–2847`) with `error_category = "MISSING_DEPENDENCY_OR_PACKAGE"` in `< 120ms`, and `dot-test-digest` emits only that 12-line window and raw log line pointer (`L2835-L2847`) to `stdout`.

## 5. Repository & Module Layout (`SPEC-LAYOUT`)

To keep the codebase modular and self-contained, the implementation SHALL follow this directory layout:

| File Path | Module Responsibility |
| :--- | :--- |
| `package.json` | Package manifest (`dot-test-digest`) with minimal runtime dependencies (`zod` and native `node:child_process`). |
| `tsconfig.json` | Strict TypeScript `5.x` compiler configuration targeting Node.js `>= 20.x`. |
| `specs/SPEC-002-DOT-TEST-DIGEST.md` | Architecture and behavioral contract specification. |
| `src/index.ts` | CLI entrypoint parsing flags, spawning child processes with pipe capture, and returning transparent exit codes (`INV-3`). |
| `src/pruner/ansi-stripper.ts` | Streaming stripper for ANSI CSI/OSC sequences, spinner carriage-returns, and passing test noise (`INV-1`). |
| `src/pruner/stack-pruner.ts` | Strips `node_modules`, `/nix/store`, `.venv`, and stdlib frames (`INV-4`) and reads $\pm 2$-line `SignalWindow` snippets from disk. |
| `src/pruner/cluster-dedup.ts` | Computes `RootCauseFingerprint` hashes and collapses cascading failures into bounded `FailureCluster` records (`INV-2`). |
| `src/adapters/index.ts` | Gear 0 deterministic grammar parsers for `vitest`/`jest`, `tsc`/`eslint`, `pytest`/`ruff`, and `cargo`/`go test`. |
| `src/gears/gear1-jev.ts` | Unstructured log window chunker (`<= 255` options `INV-6`), Jev `Choice` + `Noul` client, and transient flake retry trigger. |
| `src/state/tdd-gate.ts` | Manages `~/.cache/dot-test-digest/state-<scope_id>.json`, enforces `INV-5` (`VALID_RED` vs `INVALID_RED`), and computes `RedGreenDelta`. |
| `src/formatters/envelope.ts` | Serializes `DigestEnvelope` into compact Markdown (`--format=compact-md`) or JSON (`--format=json`). |
| `src/types/schema.ts` | Zod schemas for CLI flags, `DigestEnvelope`, `FailureCluster`, and Jev API payloads. |
| `tests/pruner.spec.ts` | Unit tests verifying ANSI stripping, stack frame pruning (`INV-4`), and `SignalWindow` source extraction. |
| `tests/dedup-and-tdd.spec.ts` | Behavioral tests verifying 50-to-1 cascade deduplication (`INV-2`) and `--tdd-phase=red` validation (`INV-5`). |
| `tests/gear1-jev.spec.ts` | Tests verifying `<= 255` candidate window partitioning (`INV-6`) and Jev unstructured build log classification. |

## 6. Acceptance Criteria & Definition of Done (`v0.1.0`)

* **Compliance Test 1 (`CT-1`: Pass-State Token Compression)**: Wrapping a passing test suite that emits `2,500 lines` (`~18,000 tokens`) of standard `vitest` + `console.log` output MUST emit `<= 160 bytes` (`<= 35 tokens`) to `stdout` (`>= 99.8%` token reduction) while preserving the full `2,500 lines` in `~/.cache/dot-test-digest/logs/<run_id>.log`.
* **Compliance Test 2 (`CT-2`: 50-to-1 Cascade Deduplication & Stack Pruning)**: Feeding a fixture where 50 tests fail across 10 files due to the same thrown exception inside a shared helper with a 35-frame `node_modules` stack trace MUST produce exactly `1` `FailureCluster` (`affected_count: 50`), `0` `node_modules` stack frames, an inlined 5-line `SignalWindow` from the helper file, and a total `stdout` payload of `<= 220 tokens` (`>= 94%` token reduction).
* **Compliance Test 3 (`CT-3`: TDD Invalid-Red Gate Enforcement)**: Running `dot-test-digest --tdd-phase=red` against (a) a passing test file and (b) a test file containing an unresolved `import` or `SyntaxError` MUST in both cases emit `status: "INVALID_RED"` and exit with code `64`; running it against a test file that fails on `expect(actual).toBe(expected)` MUST emit `status: "VALID_RED"` and exit with code `0`.
* **Compliance Test 4 (`CT-4`: Gear 1 Jev Unstructured Build Pinpointing)**: Feeding a `3,000-line` unstructured linker failure fixture (where the actual linker error occurs 400 lines above the end of the log) with Jev (`jev-1.13.0+`) MUST send `<= 255` candidate windows in a single RPC call, complete in `< 150ms`, and return a `FailureCluster` containing the exact linker error window.
* **Compliance Test 5 (`CT-5`: Concurrent Scope Isolation)**: Running two concurrent `dot-test-digest` processes with `--scope-id=s01` and `--scope-id=s02` MUST write isolated state files (`state-s01.json` and `state-s02.json`) with zero file lock contention or cross-run `RedGreenDelta` contamination.