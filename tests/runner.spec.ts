import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RawLogWriter, formatLineRange } from "../src/runner/raw-log.js";
import { runChild, signalExitCode } from "../src/runner/capture.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dtd-runner-"));
}

describe("RawLogWriter", () => {
  it("writes chunks to disk and reports the first line number of each chunk", () => {
    const dir = tempHome();
    const log = new RawLogWriter({ dir });
    expect(log.write("a\nb\n")).toBe(1);
    expect(log.write("c\n")).toBe(3);
    log.close();
    expect(fs.readFileSync(log.path, "utf8")).toBe("a\nb\nc\n");
    expect(log.path.startsWith(dir)).toBe(true);
    expect(path.basename(log.path)).toMatch(/^run_[a-z0-9]+\.log$/);
  });

  it("formats a line range pointer", () => {
    expect(formatLineRange(412, 448)).toBe("L412-L448");
  });
});

describe("runChild", () => {
  it("captures stdout and stderr with absolute line numbers", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(
      ["node", "-e", "process.stdout.write('one\\n'); process.stderr.write('two\\n')"],
      { rawLog: log },
    );
    log.close();
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.lines).toEqual([
      { stream: "stdout", text: "one", line: 1 },
      { stream: "stderr", text: "two", line: 2 },
    ]);
  });

  it("reports the child exit code unchanged", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(["node", "-e", "process.exit(42)"], { rawLog: log });
    log.close();
    expect(result.exitCode).toBe(42);
  });

  it("captures a partial final line", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(["node", "-e", "process.stdout.write('no newline')"], {
      rawLog: log,
    });
    log.close();
    expect(result.lines).toEqual([{ stream: "stdout", text: "no newline", line: 1 }]);
  });

  it("maps a fatal signal to 128 + signal number", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    const result = await runChild(
      ["node", "-e", "process.kill(process.pid, 'SIGTERM')"],
      { rawLog: log },
    );
    log.close();
    expect(result.signal).toBe("SIGTERM");
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  it("throws a readable error when the command does not exist", async () => {
    const log = new RawLogWriter({ dir: tempHome() });
    await expect(runChild(["definitely-not-a-command-xyz"], { rawLog: log })).rejects.toThrow(
      /ENOENT/,
    );
    log.close();
  });
});
