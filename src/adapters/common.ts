import type { RawFailure } from "../pruner/cluster-dedup.js";
import type { CapturedLine } from "../runner/capture.js";
import type { ErrorKind } from "../types/schema.js";

export interface AdapterCounts {
  passed: number;
  failed: number;
  skipped: number;
}

export interface AdapterResult {
  adapter: string;
  failures: RawFailure[];
  counts: AdapterCounts;
}

export interface Adapter {
  name: string;
  /** Returns 0 when the stream is not this grammar; higher is a better match. */
  detect(lines: readonly string[]): number;
  parse(lines: readonly CapturedLine[]): AdapterResult;
}

const SYNTAX_TOKENS: readonly RegExp[] = [
  /SyntaxError/,
  /Cannot find module/,
  /Failed to resolve/,
  /Failed to load url/,
  /ERR_MODULE_NOT_FOUND/,
  /ModuleNotFoundError/,
  /ImportError/,
  /\bTS2307\b/,
  /\bTS1\d{3}\b/,
  /Unexpected token/,
  /Unexpected end of input/,
];

const TIMEOUT_TOKENS: readonly RegExp[] = [
  /Timeout of \d+ms exceeded/,
  /\btimed out\b/i,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /EADDRINUSE/,
];

const ASSERTION_TOKENS: readonly RegExp[] = [
  /AssertionError/,
  /^Assertion\b/,
  /\bexpect\(/,
  /\bexpected\b.*\bto (?:be|equal|match|contain|throw)\b/i,
  /^\s*assert\b/,
];

/**
 * R15: "does not provide an export named X" is INV-5's *missing exported symbol
 * under test*, which is a valid red. Node reports it as a SyntaxError, so it has
 * to be classified before the syntax tokens.
 */
const MISSING_EXPORT_TOKENS: readonly RegExp[] = [
  /does not provide an export named/,
  /has no exported member/,
  /is not exported from/,
];

/** Single source of truth for `error_kind` on a free-text message. */
export function classifyMessage(message: string): ErrorKind {
  if (MISSING_EXPORT_TOKENS.some((token) => token.test(message))) return "RUNTIME_EXCEPTION";
  if (SYNTAX_TOKENS.some((token) => token.test(message))) return "SYNTAX_IMPORT_ERROR";
  if (TIMEOUT_TOKENS.some((token) => token.test(message))) return "TIMEOUT_OR_CONN_REFUSED";
  if (ASSERTION_TOKENS.some((token) => token.test(message))) return "ASSERTION_FAILURE";
  return "RUNTIME_EXCEPTION";
}

export function emptyCounts(): AdapterCounts {
  return { passed: 0, failed: 0, skipped: 0 };
}

/** Reads `N passed | N failed | N skipped` out of one summary line, if present. */
export function readCountTokens(line: string): AdapterCounts | null {
  const failed = /(\d+)\s+failed\b/i.exec(line);
  const passed = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(line);
  const skipped = /(\d+)\s+(?:skipped|pending|ignored|todo)\b/i.exec(line);
  if (failed === null && passed === null && skipped === null) return null;
  return {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0,
  };
}

/** Summary lines may report the same totals twice (test files vs tests). */
export function mergeCounts(into: AdapterCounts, from: AdapterCounts): AdapterCounts {
  return {
    passed: Math.max(into.passed, from.passed),
    failed: Math.max(into.failed, from.failed),
    skipped: Math.max(into.skipped, from.skipped),
  };
}
