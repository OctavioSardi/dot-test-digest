const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const SINGLE_ESCAPE = /\u001b[@-Z\\-_]/g;

const PASS_MARKERS: readonly RegExp[] = [
  /^\s*[✓✔√·•]\s/,
  /^\s*✓/,
  /^\s*PASS\s/,
  /^\s*ok\s+\d+\s/,
  /^\s*Test Files\s+\d+\s+passed/,
  /^\s*\d+\s+passing\s*\(/,
];

/** Removes ANSI CSI/OSC sequences and stray escape bytes. */
export function stripAnsi(input: string): string {
  return input.replace(OSC, "").replace(CSI, "").replace(SINGLE_ESCAPE, "");
}

/**
 * Normalises a single physical line: strips ANSI, keeps only the segment after
 * the last `\r` (progress spinners), and trims trailing whitespace.
 * Never merges or drops lines — raw-log line numbers depend on a 1:1 mapping.
 */
export function normalizeLine(input: string): string {
  const stripped = stripAnsi(input);
  const carriageReturn = stripped.lastIndexOf("\r");
  const visible = carriageReturn === -1 ? stripped : stripped.slice(carriageReturn + 1);
  return visible.replace(/[ \t]+$/, "");
}

/** Splits a blob and normalises each line, preserving the line count. */
export function normalizeLines(input: string): string[] {
  return input.split("\n").map(normalizeLine);
}

export function isPassingNoise(line: string): boolean {
  return PASS_MARKERS.some((pattern) => pattern.test(line));
}

export function stripPassingNoise(lines: readonly string[]): string[] {
  return lines.filter((line) => !isPassingNoise(line));
}
