import fs from "node:fs";
import path from "node:path";
import { MAX_REPO_FRAMES } from "../types/schema.js";

const EXTERNAL_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])node_modules[\\/]/,
  /(^|[\\/])nix[\\/]store[\\/]/,
  /(^|[\\/])\.venv[\\/]/,
  /(^|[\\/])site-packages[\\/]/,
  /^\/usr\/(?:lib|local|share)\//,
  /^\/rustc\//,
  /(^|[\\/])rustlib[\\/]/,
  /(^|[\\/])go[\\/]src[\\/]/,
  /(^|[\\/])src[\\/]runtime[\\/]/,
  /^internal\//,
];

/** Runtime markers that only make sense when read from the whole frame. */
const EXTERNAL_FRAME_PATTERNS: readonly RegExp[] = [/(?:^|[\s(])node:/];

/** Engine frames carry no file path at all, so they are never code you can open. */
const INTERNAL_FRAME_PATTERNS: readonly RegExp[] = [
  /<anonymous>/,
  /\(index \d+\)/,
  /<frozen /,
];

const FRAME_FILE = /((?:[A-Za-z]:)?[^\s()"']+\.(?:[cm]?[jt]sx?|py|rs|go)):(\d+)(?::(\d+))?/;
const FRAME_SYMBOL = /\bat\s+([^\s(]+)\s*\(/;
const PY_SYMBOL = /\bin\s+([A-Za-z_][\w.]*)\s*$/;

export interface FrameLocation {
  frame: string;
  file: string | null;
  line: number | null;
  column: number | null;
  symbol: string | null;
}

export interface ResolvedFrame {
  location: string;
  file: string;
  line: number;
  column: number;
}

export function parseFrame(frame: string): FrameLocation {
  const match = FRAME_FILE.exec(frame);
  const symbol = FRAME_SYMBOL.exec(frame) ?? PY_SYMBOL.exec(frame);
  return {
    frame: frame.trim(),
    file: match?.[1] ?? null,
    line: match?.[2] ? Number(match[2]) : null,
    column: match?.[3] ? Number(match[3]) : null,
    symbol: symbol?.[1] ?? null,
  };
}

/** A frame the engine emitted and that names no file: never useful, never a boundary. */
export function isEngineFrame(frame: string): boolean {
  return (
    parseFrame(frame).file === null &&
    INTERNAL_FRAME_PATTERNS.some((pattern) => pattern.test(frame))
  );
}

export function isExternalFrame(frame: string): boolean {
  if (EXTERNAL_FRAME_PATTERNS.some((pattern) => pattern.test(frame))) return true;
  const parsed = parseFrame(frame);
  if (parsed.file === null) return isEngineFrame(frame);
  return EXTERNAL_PATH_PATTERNS.some((pattern) => pattern.test(parsed.file ?? frame));
}

export function toRepoRelative(file: string, repoRoot: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  if (relative === "" || relative.startsWith("..")) {
    return file.split(path.sep).join("/");
  }
  return relative;
}

/**
 * INV-4: keep up to five repository frames plus, at most, the single external
 * boundary frame that follows them (the exact third-party call site).
 */
export function pruneStack(frames: readonly string[], repoRoot: string): string[] {
  const kept: string[] = [];
  let repoFrames = 0;
  let boundaryKept = false;

  for (const frame of frames) {
    if (isEngineFrame(frame)) continue;
    if (isExternalFrame(frame)) {
      if (!boundaryKept && repoFrames > 0) {
        kept.push(frame.trim());
        boundaryKept = true;
      }
      continue;
    }
    if (repoFrames >= MAX_REPO_FRAMES) continue;
    kept.push(frame.trim());
    repoFrames += 1;
  }

  return kept;
}

export function topRepoFrame(
  frames: readonly string[],
  repoRoot: string,
): ResolvedFrame | null {
  for (const frame of frames) {
    if (isExternalFrame(frame)) continue;
    const parsed = parseFrame(frame);
    if (parsed.file === null || parsed.line === null) continue;
    const file = toRepoRelative(parsed.file, repoRoot);
    const column = parsed.column ?? 1;
    return { location: `${file}:${parsed.line}:${column}`, file, line: parsed.line, column };
  }
  return null;
}

/**
 * Reads ±contextLines around `line` from `file`, marking the target with `>`.
 * Format: `28 >   return parts.split('.')`.
 */
export function readSignalWindow(
  file: string,
  line: number,
  contextLines = 2,
  repoRoot = process.cwd(),
): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  let source: string[];
  try {
    source = fs.readFileSync(absolute, "utf8").split("\n");
  } catch {
    return "";
  }
  // A file that ends with a newline would otherwise expose a phantom last line.
  if (source.length > 1 && source[source.length - 1] === "") source.pop();

  const start = Math.max(1, line - contextLines);
  const end = Math.min(source.length, line + contextLines);
  const width = String(end).length;
  const rows: string[] = [];

  for (let current = start; current <= end; current += 1) {
    const marker = current === line ? " >" : " |";
    rows.push(`${String(current).padStart(width)}${marker} ${source[current - 1] ?? ""}`);
  }

  return rows.join("\n");
}
