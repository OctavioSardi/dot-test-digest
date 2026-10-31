# Acceptance harness

One script that exercises the **built** binary against the spec
(`specs/SPEC-002-DOT-TEST-DIGEST.md`, v0.1.1) using fixtures it generates
itself. It is deliberately separate from `tests/`: those are unit and
compliance tests that run in-process, this runs the real CLI against real
child processes.

```bash
pnpm build
node scripts/acceptance/run-acceptance.mjs
```

Everything is written under `.acceptance/run-<timestamp>/`:

| Path | Contents |
| :--- | :--- |
| `summary.md` | Human-readable verdict, one row per check |
| `report.json` | Same data, machine-readable (assertions, commands, exit codes) |
| `transcript.log` | Console transcript of the run |
| `artifacts/<ID>.txt` | Raw stdout/stderr of every command in that check |
| `fixtures/` | The generated projects and scripts that were run |
| `cache/` | Copy of the tool's `DOT_TEST_DIGEST_HOME` (raw logs + state files) |
| `../LATEST` | Path of the most recent run |

The live cache lives in the system temp dir so that a 160-byte pass line still
has room for its log pointer; the copy under `cache/` is what you inspect.

## What is checked

| ID | Spec clause | Assertion |
| :-- | :-- | :-- |
| C01 | CLI surface | `--version` prints the package version; `--help` exits 0 and documents flags/env |
| C02 | CLI surface | Unknown flag, missing `--`, `--no-jev=maybe`, `--max-clusters=99` all exit 64 with a diagnostic |
| C03 | INV-1, CT-1 | 2,500+ lines of passing output become one line of ≤160 bytes; the raw log keeps every line |
| C04 | INV-2, CT-2 | 50 failures in 10 files become exactly 1 cluster (`x50`), ≤2,400 bytes, no `node_modules` |
| C05 | INV-2, INV-4 | The same run in JSON: status, counts, ≤6 pruned frames, valid `L<n>-L<m>` pointer |
| C06 | §4.2 | `signal_window` marks the failing line with `>` and matches the file on disk |
| C07 | INV-3 | A child exiting 42 makes the tool exit 42 |
| C08 | INV-3 | A child killed by SIGTERM makes the tool exit 143 and records the signal |
| C09 | INV-3 | A nonexistent command exits 127 |
| C10 | INV-5, CT-3 | Red phase + passing file → `INVALID_RED`, exit 64 |
| C11 | INV-5, CT-3 | Red phase + broken import → `INVALID_RED`, exit 64 |
| C12 | INV-5, CT-3 | Red phase + assertion failure → `VALID_RED`, exit 0, baseline persisted |
| C13 | INV-5, R15 | Red phase + missing exported symbol → `VALID_RED`, exit 0 |
| C14 | §4.3, CT-5 | Green after red → `PASS \| GREEN` with `delta: +1 newly passing, 0 regressions` |
| C15 | CT-5 | Two concurrent scopes write two state files, no `.tmp` residue |
| C16 | §4.4 | A 3,000-line unstructured failure → `BUILD_ERROR`, ≤2,400 bytes, heuristic fallback, raw pointer |
| C17 | CT-1 | The tool digests its own suite (≥100 tests) into one ≤160-byte line |
| C18 | §4.4, INV-6 | **Opt-in.** With `TYPESAFE_API_KEY`: exactly one `POST /v1/systemone`, lowercase question types, ≤255 criteria, `state.exit_code` present |

C18 skips by default. It routes the request through a local proxy that
forwards to `api.typesafe.ai`, records the body and replays the response, so
the wire contract is verified independently of what the binary prints.

## Notes

- C14 depends on C12 (they share the `acc-red` scope on purpose, because the
  delta is what is being tested). If C12 fails, C14's failure is a
  consequence, not a second bug.
- C03 asserts its own fixture sanity (`>=2,500` lines before digesting). If
  that particular assertion fails while the rest pass, the fixture and the
  runner disagree about console capture — say so rather than treating it as a
  product defect.
- Observations (heuristic window choice, compression ratio, upstream status)
  are recorded but never cause a failure.
- The harness never writes to `~/.cache/dot-test-digest`.
