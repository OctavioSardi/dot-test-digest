/**
 * Canonical failure identity (SPEC-002 §4.2.2 / §4.3).
 *
 * A runner can mention the same failing test twice — once in its inline
 * reporter block, once in a deduplicated summary — and it decorates rows with
 * presentation details such as `12ms`. Baseline records, `RedGreenDelta` and
 * deduplication must all agree on one identity per test, or a single failure
 * is counted twice.
 */

import type { RawFailure } from "./cluster-dedup.js";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** `tests/auth.spec.ts > ` prefix that some reporters put inside the row. */
const FILE_PREFIX = /^\S+\.(?:spec|test)\.[cm]?[jt]sx?\s*>\s*/;
/** Vitest appends per-test durations to inline failing rows. */
const TRAILING_DURATION = /\s+\d+(?:\.\d+)?\s*(?:ms|s)\s*$/;
const LEADING_DECORATION = /^(?:\[[^\]]+\]\s+›\s+|-\s*)/;

/** Strips presentation from a test name without changing its meaning. */
export function normalizeTestName(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(LEADING_DECORATION, "")
    .replace(FILE_PREFIX, "")
    .replace(TRAILING_DURATION, "")
    .trim();
}

/**
 * `<repo-relative test file>::<test name>`, or just the name when the stream
 * never revealed a file. Returns null for an anonymous failure.
 */
export function canonicalTestId(
  testFile: string | null | undefined,
  testName: string | null | undefined,
): string | null {
  if (testName === null || testName === undefined) return null;
  const normalized = normalizeTestName(testName);
  if (normalized === "") return null;
  const file = (testFile ?? "").trim();
  return file === "" ? normalized : `${file}::${normalized}`;
}

/** Keeps the first record per canonical identity; anonymous failures all pass. */
export function uniqueFailures(failures: readonly RawFailure[]): RawFailure[] {
  const seen = new Set<string>();
  const kept: RawFailure[] = [];
  for (const failure of failures) {
    const identity = canonicalTestId(failure.testFile, failure.testName);
    if (identity !== null) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    kept.push(failure);
  }
  return kept;
}
