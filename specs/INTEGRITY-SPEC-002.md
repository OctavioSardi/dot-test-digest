# Integrity Review: `SPEC-002-DOT-TEST-DIGEST` v0.1.0

| Field | Value |
|---|---|
| **Review ID** | `REVIEW-SPEC-002-INTEGRITY` |
| **Reviewed artifact** | `specs/SPEC-002-DOT-TEST-DIGEST.md` (sha256 `09c597de4d5f38a6c6095bdcf0275b767b6f80c86ac4e778a7c46297552c4e1a`) |
| **Reviewed against** | Itself (internal consistency), SPEC-002 §5 (its own layout contract), and the external dependency it pins: TypeSafe AI Jev `jev-1.13.0` |
| **Status** | `FINDINGS OPEN` — 6 blocking/major, 4 minor, 0 structural |
| **Date** | 2026-10-30 |
| **Verdict** | Implementable as specified once R1–R10 below are applied. No rewrite required. |

---

## 1. What was checked

1. **Structure** — sections, IDs, and cross-references are present and resolvable.
2. **Schema validity** — the `DigestEnvelope` JSON Schema block in §4.1 parses as valid JSON.
3. **ID coverage** — every `INV-*`, `REQ-*`, `CT-*` and `Scenario N` is referenced where it claims to be.
4. **Behavioral consistency** — invariants vs. requirement tables vs. compliance tests vs. scenarios.
5. **External contract** — every claim made about the pinned upstream (`zod`, Jev `jev-1.13.0`) verified against that upstream's live documentation.
6. **Location contract** — §5 requires the spec itself to live at `specs/SPEC-002-DOT-TEST-DIGEST.md`. It did not; it was at the repository root as `spec_dot_test_digest.md`. Moved with byte-for-byte integrity (same sha256 before and after).

## 2. Findings

Severity: **B** = blocks implementation, **M** = major (ambiguous or contradictory behavior), **m** = minor (editorial/coverage).

| ID | Sev | Location | Finding | Resolution |
|---|---|---|---|---|
| **F1** | B | §4.4.2, §4.4.3 | The Jev wire contract is wrong. The spec says `POST /v1/jev` with `type: "Choice"` / `type: "Noul"`. The real endpoint is `POST https://api.typesafe.ai/v1/systemone`, questions are a **map keyed by caller-chosen id**, `type` values are lowercase `choice` / `noul`, and a `choice` question's `criteria` is a **map** of option name → description. | R1 |
| **F2** | B | §4.1 enum vs §4.3 / CT-3 | `status` enum is `PASS \| FAIL \| INVALID_RED \| REGRESSION_DETECTED \| BUILD_ERROR`, but §4.3 and CT-3 require `status: "VALID_RED"`. A conforming implementation cannot satisfy both. | R2 |
| **F3** | B | §4.4.3 + §5 (`gear1-jev.ts`) | `--retry-flakes` is required by the retry rule and named in the module table, but is absent from the §4.1 flag table. Undefined CLI surface. | R3 |
| **F4** | M | §4.4.3 | "`is_transient_flake == true` with confidence `>= 0.80`". A Jev `Noul` has **no** `confidence` field; it returns a single probability in `answers.<id>.noul`. | R4 |
| **F5** | M | §4.1 enum | `BUILD_ERROR` is a valid `status` but no rule in §4.2–§4.4 ever assigns it. | R5 |
| **F6** | M | INV-4 vs §4.1 schema | INV-4 permits *1 external boundary frame + up to 5 repository frames* (6 lines). The schema caps `pruned_stack` at `maxItems: 5`. | R6 |
| **F7** | M | §4.4.1 vs §4.2 | Escalation to Gear 1 requires "zero structured `FailureCluster` matches", but a grammar adapter may *match* a runner while yielding zero failures (runner startup crash). As written the run can match an adapter, produce nothing, and never escalate. | R7 |
| **F8** | m | §6 | INV-3 (exit-code / signal transparency) has no compliance test and §5 has no CLI test file, so the most safety-critical invariant is untested. | R8 |
| **F9** | m | §4.3 `green` row | The green row only defines the pass case. Behavior when a previously-red test still fails, or a new test breaks, is unspecified. | R9 |
| **F10** | m | INV-2 vs `--context-lines` | 5 clusters × (11-line `SignalWindow` + pruned stack + message) can exceed the 600-token ceiling; the spec states the ceiling as an invariant but names no truncation policy. | R10 |
| **F11** | m | whole document | LaTeX fragments (`$>150$`, `$\pm 2$`) render as literal dollar text in Markdown viewers, and the header omits the `Date` / `Depends on` rows used by sibling specs. Editorial only. | v0.1.1 editorial pass |

## 3. Verified correct (no action)

| Claim | Verification |
|---|---|
| **`Noul` is a real question type**, not a typo. | TypeSafe Jev 1.13 exposes exactly `choice`, `score`, `noul`, `box`; `noul` answers are `{ "type": "noul", "noul": 0.98 }`. |
| **INV-6's 255-option ceiling is implementable and is the upstream maximum.** | `ChoiceQuestion.criteria` in the Jev OpenAPI schema is `maxProperties: 255`. The 252-salient + 3-tail partition therefore leaves zero headroom, which the partitioner must respect exactly. |
| **Jev asks multiple questions in one request, in parallel.** | Confirms §4.4.2's "single RPC call bundling three questions" is the documented best practice, not a workaround. |
| **`DigestEnvelope` example schema is valid JSON.** | Parsed: 1 block, 2,586 chars, no syntax errors. |
| **Scenario 1's pass line fits INV-1.** | Rendered: 128 bytes / 32 estimated tokens (see R10 for the path-truncation budget). |
| **§4.3's gate table is internally complete** once `VALID_RED` is added to the status enum (F2) and the green failure case is defined (F9). | |

## 4. Resolutions adopted by the implementation plan

These are binding for `docs/superpowers/plans/2026-10-30-dot-test-digest.md`. Each is a **spec amendment candidate** for v0.1.1; none changes an invariant's intent.

| ID | Resolution |
|---|---|
| **R1** | Implement the real Jev 1.13 contract in `src/gears/jev-client.ts`: `POST {base}/v1/systemone`, `Authorization: Bearer <TYPESAFE_API_KEY>`, body `{ model: "jev-1.13.0", state, questions: { id: { type, instructions, criteria } } }`, response `{ model, answers, usage }`. Keep the spec's vocabulary (Choice/Noul) in *our* domain types only. |
| **R2** | Add `VALID_RED` to the `status` enum. Rationale: CT-3 asserts it verbatim, and the alternative (reuse `FAIL`) would make the red phase indistinguishable from an ordinary failing run in the envelope. |
| **R3** | Add `--retry-flakes` (`boolean`, default `false`) to the CLI. Retry happens at most once, and only when Gear 1 returns `noul ≥ 0.80` for the flake question. |
| **R4** | Treat the Noul probability as the confidence: retry iff `answers.is_transient_flake.noul >= 0.80`. Constant: `FLAKE_PROBABILITY_THRESHOLD = 0.8`. |
| **R5** | `BUILD_ERROR` is emitted when the failure came from Gear 1 or the Gear 0 heuristic fallback (i.e. no grammar adapter produced a failure cluster). `FAIL` is emitted when a grammar adapter produced clusters. |
| **R6** | `pruned_stack` gets `maxItems: 6`: up to 5 repository frames plus at most 1 external boundary frame, in original order, boundary only if it follows a repository frame. |
| **R7** | Escalate to Gear 1 when `exit_code != 0 && clusters.length === 0 && lines > 150`, regardless of adapter match. This strictly widens F7's condition; it cannot mask a grammar result because it requires zero clusters. |
| **R8** | Add `tests/cli.spec.ts` covering: exact child exit code passthrough (`INV-3`), signal termination mapped to `128 + signal number`, `EX_USAGE` (64) on bad flags, and the pass-state byte ceiling. |
| **R9** | `green` + `exit_code != 0` → `status: "FAIL"`, exit with the child's code, `delta` populated. `green` + `exit 0` → `PASS`. A green run that re-breaks a baseline test is thus visible via `newly_broken_regressions`. |
| **R10** | The formatter enforces both ceilings as hard invariants: pass line truncated to `≤160` bytes (log path shortened to `~/...` first), fail body capped at `≤2400` bytes (≈600 tokens at 4 bytes/token), dropping the lowest-severity clusters first and appending `+N more clusters (see log)`. |
| **R11** | Gear 1 sends a *bounded* `state`: the command line, exit code, total line count, and the last 40 lines. The candidate windows travel as `choice` criteria, which is what makes the request fit the 64k context and stay sub-120ms. The spec does not define `state`; this is the only shape consistent with INV-6. |
| **R12** | Cache root is overridable with `DOT_TEST_DIGEST_HOME` (defaults to `~/.cache/dot-test-digest`) so tests never touch the developer's real cache and CT-5 can run in a temp dir. |

## 5. Amendments to file against the spec (v0.1.1)

1. §4.1: add `VALID_RED` to the `status` enum (R2); add `--retry-flakes` to the flag table (R3); widen `pruned_stack` to `maxItems: 6` (R6).
2. §4.4.2: correct the endpoint to `POST /v1/systemone`, lowercase `type` values, question map, and Choice `criteria` map semantics (R1).
3. §4.4.3: replace "confidence `>= 0.80`" with "Noul probability `>= 0.80`" (R4); define `state` (R11).
4. §4.4: widen the escalation predicate per R7.
5. §4.3: add the green failure row (R9).
6. §6: add a compliance test for INV-3 (R8) and state the truncation policy in INV-2 (R10).
7. Editorial: drop LaTeX fences, add `Date` / `Depends on` header rows (F11).

## 6. Layout compliance

| Spec §5 path | Status |
|---|---|
| `specs/SPEC-002-DOT-TEST-DIGEST.md` | Present (moved 2026-10-30, bytes unchanged) |
| `package.json`, `tsconfig.json`, `src/**`, `tests/**` | Scheduled as plan Tasks 1–13 |

Additive files that §5 does not name, required to satisfy invariants the table implies (`src/runner/*` for raw-log line mapping, `src/cli/args.ts`, `src/gears/windows.ts`, `src/gears/jev-client.ts`, `tests/cli.spec.ts`, `tests/adapters.spec.ts`, `tests/fixtures/**`, `.env.example`). Every path named in §5 still exists with exactly its stated responsibility.
