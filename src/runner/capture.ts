import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { RawLogWriter } from "./raw-log.js";

export type StreamName = "stdout" | "stderr";

export interface CapturedLine {
  stream: StreamName;
  text: string;
  line: number;
}

export interface CaptureResult {
  lines: CapturedLine[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface CaptureOptions {
  rawLog: RawLogWriter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** POSIX convention: a signal death is reported as 128 + signal number. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0;
  const number = constants.signals[signal];
  return 128 + (typeof number === "number" ? number : 0);
}

export function runChild(
  command: readonly string[],
  options: CaptureOptions,
): Promise<CaptureResult> {
  const [binary, ...args] = command;
  if (binary === undefined) return Promise.reject(new Error("runChild: empty command"));

  const startedAt = Date.now();
  const child = spawn(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const lines: CapturedLine[] = [];
  const pending: Record<StreamName, string> = { stdout: "", stderr: "" };
  const decoders: Record<StreamName, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };

  const ingest = (stream: StreamName, text: string): void => {
    pending[stream] += text;
    const parts = pending[stream].split("\n");
    pending[stream] = parts.pop() ?? "";
    if (parts.length === 0) return;
    const first = options.rawLog.write(parts.map((part) => `${part}\n`).join(""));
    parts.forEach((part, offset) => lines.push({ stream, text: part, line: first + offset }));
  };

  child.stdout.on("data", (chunk: Buffer) => ingest("stdout", decoders.stdout.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => ingest("stderr", decoders.stderr.write(chunk)));

  return new Promise<CaptureResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      ingest("stdout", decoders.stdout.end());
      ingest("stderr", decoders.stderr.end());
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = pending[stream];
        if (rest.length === 0) continue;
        const first = options.rawLog.write(`${rest}\n`);
        lines.push({ stream, text: rest, line: first });
        pending[stream] = "";
      }
      resolve({
        lines,
        exitCode: code ?? signalExitCode(signal),
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
