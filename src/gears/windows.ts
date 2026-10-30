import type { CapturedLine } from "../runner/capture.js";

export const WINDOW_SIZE = 12;
export const WINDOW_STRIDE = 6;
export const MAX_CANDIDATE_WINDOWS = 255;
export const SALIENCE_HEADROOM = 252;
export const TAIL_WINDOWS = 3;
export const EXCERPT_PADDING = 10;

const SALIENCE_TOKENS: readonly RegExp[] = [
  /undefined reference/i,
  /permission denied/i,
  /no such file or directory|enoent/i,
  /exit status/i,
  /traceback/i,
  /panicked|panic:/i,
  /fatal/i,
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
];

export interface LogWindow {
  id: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export function scoreWindow(lines: readonly string[]): number {
  let score = 0;
  for (const line of lines) {
    for (const token of SALIENCE_TOKENS) {
      if (token.test(line)) score += 1;
    }
  }
  return score;
}

export function partitionWindows(lines: readonly CapturedLine[]): LogWindow[] {
  const windows: LogWindow[] = [];

  for (let index = 0; index < lines.length; index += WINDOW_STRIDE) {
    const slice = lines.slice(index, index + WINDOW_SIZE);
    if (slice.length === 0) break;
    const text = slice.map((line) => line.text);
    windows.push({
      id: `w_${windows.length + 1}`,
      startLine: slice[0]?.line ?? index + 1,
      endLine: slice[slice.length - 1]?.line ?? index + 1,
      score: scoreWindow(text),
      text: text.join("\n"),
    });
    if (index + WINDOW_SIZE >= lines.length) break;
  }

  return windows;
}

/** INV-6: 252 highest-salience windows plus the 3 tail windows, never above 255. */
export function selectCandidateWindows(windows: readonly LogWindow[]): LogWindow[] {
  const salient = windows.filter((window) => window.score > 0);
  const selected =
    salient.length <= SALIENCE_HEADROOM
      ? [...salient]
      : [...salient]
          .sort((a, b) => b.score - a.score || a.startLine - b.startLine)
          .slice(0, SALIENCE_HEADROOM);

  const seen = new Set(selected.map((window) => window.id));
  for (const window of windows.slice(-TAIL_WINDOWS)) {
    if (seen.has(window.id)) continue;
    selected.push(window);
    seen.add(window.id);
  }

  return selected.sort((a, b) => a.startLine - b.startLine).slice(0, MAX_CANDIDATE_WINDOWS);
}
