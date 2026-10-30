import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

const BLOCK_HEADER = /^_{2,}\s+(.+?)\s+_{2,}$/;
const LOCATION = /^(\S+\.py):(\d+):\s+in\s+(\S+)$/;
const ERROR_LINE = /^E\s{2,}(.+)$/;
const SHORT_SUMMARY = /^FAILED\s+(\S+?)(?:::(\S+))?\s+-\s+(.*)$/;
const SESSION_SUMMARY = /^=+\s.*\b(?:failed|passed|error)\b.*=+$/;
const SESSION_START = /test session starts/;

export const pythonAdapter: Adapter = {
  name: "python",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (BLOCK_HEADER.test(line)) score += 3;
      else if (LOCATION.test(line)) score += 2;
      else if (SHORT_SUMMARY.test(line)) score += 3;
      else if (SESSION_START.test(line)) score += 2;
      else if (SESSION_SUMMARY.test(line)) score += 2;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let counts: AdapterCounts = emptyCounts();
    let current: RawFailure | null = null;
    let sawBlock = false;

    const flush = (): void => {
      if (current === null) return;
      current.errorKind = classifyMessage(`${current.message}\n${current.frames.join("\n")}`);
      if (current.message === "") current.message = "Unknown pytest failure";
      failures.push(current);
      current = null;
    };

    for (const line of lines) {
      const text = line.text;

      const header = BLOCK_HEADER.exec(text);
      if (header) {
        flush();
        sawBlock = true;
        current = {
          testName: (header[1] ?? "").trim(),
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        continue;
      }

      if (SESSION_SUMMARY.test(text)) {
        const tokens = readCountTokens(text);
        if (tokens !== null) counts = mergeCounts(counts, tokens);
        continue;
      }

      if (current !== null) {
        current.endLine = line.line;
        const location = LOCATION.exec(text);
        if (location) {
          current.frames.push(`${location[1]}:${location[2]}`);
          continue;
        }
        const error = ERROR_LINE.exec(text);
        if (error?.[1] !== undefined && current.message === "") {
          current.message = error[1].trim();
          continue;
        }
        continue;
      }

      const short = SHORT_SUMMARY.exec(text);
      if (short && !sawBlock) {
        failures.push({
          testName: (short[2] ?? short[1] ?? "").trim(),
          errorKind: classifyMessage(short[3] ?? ""),
          message: (short[3] ?? "").trim(),
          frames: [],
          startLine: line.line,
          endLine: line.line,
        });
      }
    }

    flush();
    if (counts.failed === 0) counts.failed = failures.length;
    return { adapter: "python", failures, counts };
  },
};
