import type { CapturedLine } from "../runner/capture.js";
import { jsTestAdapter } from "./js-test.js";
import { pythonAdapter } from "./python.js";
import { rustGoAdapter } from "./rust-go.js";
import { tscEslintAdapter } from "./tsc-eslint.js";
import type { Adapter, AdapterResult } from "./common.js";

export {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

/** A single stray `FAIL\tpkg\t0.2s` line scores 1; a real grammar scores 3 or more. */
const MIN_ADAPTER_SCORE = 3;

export const ADAPTERS: readonly Adapter[] = [
  jsTestAdapter,
  tscEslintAdapter,
  pythonAdapter,
  rustGoAdapter,
];

export function selectAdapter(lines: readonly string[]): Adapter | null {
  let best: { adapter: Adapter; score: number } | null = null;
  for (const adapter of ADAPTERS) {
    const score = adapter.detect(lines);
    if (score < MIN_ADAPTER_SCORE) continue;
    if (best === null || score > best.score) best = { adapter, score };
  }
  return best?.adapter ?? null;
}

/** Runs the winning grammar, or returns null when Gear 0 has nothing to say. */
export function runGear0(lines: readonly CapturedLine[]): AdapterResult | null {
  const adapter = selectAdapter(lines.map((line) => line.text));
  return adapter === null ? null : adapter.parse(lines);
}
