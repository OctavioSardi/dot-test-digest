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

const CARGO_DIAG = /^error(?:\[(\w+)\])?:\s+(.+)$/;
const CARGO_SPAN = /^\s*-->\s+(\S+):(\d+):(\d+)/;
const CARGO_PANIC = /^thread '(.+?)' panicked at (.+?):(\d+):(\d+)/;
const CARGO_SUMMARY = /^test result: (?:FAILED|ok)\.\s*(.*)$/;
const GO_FAIL = /^--- FAIL: (\S+)/;
const GO_LOCATION = /^\s+(\S+_test\.go):(\d+):\s+(.*)$/;

export const rustGoAdapter: Adapter = {
  name: "rust-go",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (CARGO_DIAG.test(line)) score += 3;
      else if (CARGO_PANIC.test(line)) score += 3;
      else if (GO_FAIL.test(line)) score += 3;
      else if (GO_LOCATION.test(line)) score += 2;
      else if (CARGO_SPAN.test(line)) score += 2;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let counts: AdapterCounts = emptyCounts();
    let pendingDiagnostic: RawFailure | null = null;
    let current: RawFailure | null = null;

    for (const line of lines) {
      const text = line.text;

      const summary = CARGO_SUMMARY.exec(text);
      if (summary) {
        const tokens = readCountTokens(summary[1] ?? "");
        if (tokens !== null) counts = mergeCounts(counts, tokens);
        continue;
      }

      const diagnostic = CARGO_DIAG.exec(text);
      if (diagnostic) {
        const failure: RawFailure = {
          testName: null,
          errorKind: diagnostic[1] === "E0432" || diagnostic[1] === "E0583"
            ? "SYNTAX_IMPORT_ERROR"
            : "TYPE_COMPILE_ERROR",
          message: `${diagnostic[1] ?? "rustc"}: ${diagnostic[2] ?? ""}`,
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        failures.push(failure);
        pendingDiagnostic = failure;
        continue;
      }

      const span = CARGO_SPAN.exec(text);
      if (span && pendingDiagnostic !== null) {
        pendingDiagnostic.frames.push(`${span[1]}:${span[2]}:${span[3]}`);
        pendingDiagnostic.endLine = line.line;
        pendingDiagnostic = null;
        continue;
      }

      const panic = CARGO_PANIC.exec(text);
      if (panic) {
        current = {
          testName: (panic[1] ?? "").trim(),
          errorKind: "RUNTIME_EXCEPTION",
          message: `panicked at ${panic[2]}:${panic[3]}:${panic[4]}`,
          frames: [`${panic[2]}:${panic[3]}:${panic[4]}`],
          startLine: line.line,
          endLine: line.line,
        };
        failures.push(current);
        current = null;
        continue;
      }

      const goFail = GO_FAIL.exec(text);
      if (goFail) {
        current = {
          testName: (goFail[1] ?? "").trim(),
          errorKind: "RUNTIME_EXCEPTION",
          message: "",
          frames: [],
          startLine: line.line,
          endLine: line.line,
        };
        failures.push(current);
        continue;
      }

      if (current !== null) {
        const location = GO_LOCATION.exec(text);
        if (location) {
          current.endLine = line.line;
          current.frames.push(`${location[1]}:${location[2]}`);
          current.message = (location[3] ?? "").trim();
          current.errorKind = classifyMessage(current.message);
          current = null;
          continue;
        }
        current.endLine = line.line;
      }
    }

    for (const failure of failures) {
      if (failure.message === "") failure.message = "Unknown rust/go failure";
    }
    if (counts.failed === 0) counts.failed = failures.filter((f) => f.errorKind !== "TYPE_COMPILE_ERROR" || f.frames.length > 0).length;
    return { adapter: "rust-go", failures, counts };
  },
};
