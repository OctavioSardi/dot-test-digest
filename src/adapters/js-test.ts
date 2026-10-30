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

const HEADER = /^\s*(?:FAIL|✕|×|✗|●|not ok\s+\d+)\s+(.+?)\s*$/;
const FRAME = /^\s*(?:❯|at)\s+(.+?)\s*$/;
const ERROR_MESSAGE = /(?:^|\s)((?:[A-Za-z]*Error|AssertionError)[^\n]*)$/;
const SUMMARY = /\b(?:Tests|Test Files|Tests:)\b/;

export const jsTestAdapter: Adapter = {
  name: "js-test",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (HEADER.test(line)) score += 1;
      if (SUMMARY.test(line) || /^\s*\d+\s+passing\s*\(/.test(line)) score += 3;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let counts: AdapterCounts = emptyCounts();
    let current: RawFailure | null = null;

    const flush = (): void => {
      if (current === null) return;
      current.errorKind = classifyMessage(`${current.message}\n${current.frames.join("\n")}`);
      if (current.message === "") current.message = "Unknown test failure";
      failures.push(current);
      current = null;
    };

    for (const line of lines) {
      const text = line.text;

      const header = HEADER.exec(text);
      if (header) {
        flush();
        const name = (header[1] ?? "").replace(/^\S+\.(?:spec|test)\.[cm]?[jt]sx?\s*>\s*/, "").trim();
        current = {
          testName: name === "" ? null : name,
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        continue;
      }

      if (SUMMARY.test(text)) {
        const tokens = readCountTokens(text);
        if (tokens !== null) counts = mergeCounts(counts, tokens);
        continue;
      }

      if (current === null) {
        if (!FRAME.test(text) && !ERROR_MESSAGE.test(text)) continue;
        current = {
          testName: null,
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
      }

      current.endLine = line.line;

      if (current.message === "") {
        const message = ERROR_MESSAGE.exec(text);
        if (message?.[1] !== undefined) current.message = message[1].trim();
      }

      const frame = FRAME.exec(text);
      if (frame?.[1] !== undefined) {
        current.frames.push(frame[1]);
        continue;
      }

      const expected = /^\s*Expected\s*:?\s*(.+)$/i.exec(text);
      const received = /^\s*Received\s*:?\s*(.+)$/i.exec(text);
      if (expected !== null || received !== null) {
        const diff = current.diff ?? { expected: "", received: "" };
        if (expected?.[1] !== undefined) diff.expected = expected[1].trim();
        if (received?.[1] !== undefined) diff.received = received[1].trim();
        current.diff = diff;
        continue;
      }

      if (current.diff === undefined) {
        const inline = /\bexpected\s+(.+?)\s+to\s+(?:be|equal|match|contain|throw)\s+(.+)$/i.exec(
          text,
        );
        if (inline?.[1] !== undefined && inline[2] !== undefined) {
          current.diff = { expected: inline[2].trim(), received: inline[1].trim() };
        }
      }
    }

    flush();
    if (counts.failed === 0 && failures.length > 0) counts.failed = failures.length;
    return { adapter: "js-test", failures, counts };
  },
};
