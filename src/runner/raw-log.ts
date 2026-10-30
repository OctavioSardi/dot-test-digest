import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** R12: single override point for every cache artifact. */
export function cacheRoot(): string {
  const override = process.env["DOT_TEST_DIGEST_HOME"];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".cache", "dot-test-digest");
}

export function defaultLogDir(): string {
  return path.join(cacheRoot(), "logs");
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function formatLineRange(start: number, end: number): string {
  return `L${start}-L${end}`;
}

export interface RawLogOptions {
  dir?: string;
  runId?: string;
}

/**
 * Append-only raw stream. Only whole lines are ever written, so the file's line
 * numbers are exactly the numbers reported to the caller.
 */
export class RawLogWriter {
  readonly runId: string;
  readonly path: string;

  private readonly fd: number;
  private nextLine = 1;

  constructor(options: RawLogOptions = {}) {
    const directory = options.dir ?? defaultLogDir();
    fs.mkdirSync(directory, { recursive: true });
    this.runId = options.runId ?? newRunId();
    this.path = path.join(directory, `${this.runId}.log`);
    this.fd = fs.openSync(this.path, "a");
  }

  /** Appends a chunk of whole lines and returns the 1-based line number of its first line. */
  write(chunk: string): number {
    const first = this.nextLine;
    fs.writeSync(this.fd, chunk);
    this.nextLine += chunk.split("\n").length - 1;
    return first;
  }

  get linesWritten(): number {
    return this.nextLine - 1;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
