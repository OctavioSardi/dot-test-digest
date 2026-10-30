import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import { classifyMessage, type Adapter, type AdapterResult } from "./common.js";

const TSC = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
const ESLINT_FILE = /^(?:\/\S+|[A-Za-z]:\\\S+)$/;
const ESLINT_DIAG = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)?\s*$/;

export const tscEslintAdapter: Adapter = {
  name: "tsc-eslint",

  detect(lines) {
    let score = 0;
    for (const line of lines) {
      if (TSC.test(line)) score += 3;
      else if (ESLINT_DIAG.test(line)) score += 1;
    }
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    const failures: RawFailure[] = [];
    let errors = 0;
    let warnings = 0;
    let file = "";

    for (const line of lines) {
      const text = line.text;

      const tsc = TSC.exec(text);
      if (tsc) {
        const [, path, row, column, severity, code, message] = tsc;
        if (severity === "error") errors += 1;
        else warnings += 1;
        const isSyntax = code === "TS2307" || /^TS1\d{3}$/.test(code ?? "");
        failures.push({
          testName: null,
          errorKind: isSyntax ? "SYNTAX_IMPORT_ERROR" : "TYPE_COMPILE_ERROR",
          message: `${code ?? "TS0000"}: ${message ?? ""}`,
          frames: [`${path ?? ""}:${row ?? "0"}:${column ?? "0"}`],
          startLine: line.line,
          endLine: line.line,
        });
        continue;
      }

      if (ESLINT_FILE.test(text) && /\.(?:[cm]?[jt]sx?)$/.test(text)) {
        file = text.trim();
        continue;
      }

      const eslint = ESLINT_DIAG.exec(text);
      if (eslint && file !== "") {
        const [, row, column, severity, message] = eslint;
        if (severity === "error") errors += 1;
        else warnings += 1;
        failures.push({
          testName: null,
          errorKind: classifyMessage(message ?? ""),
          message: (message ?? "").trim(),
          frames: [`${file}:${row ?? "0"}:${column ?? "0"}`],
          startLine: line.line,
          endLine: line.line,
        });
      }
    }

    return { adapter: "tsc-eslint", failures, counts: { passed: 0, failed: errors, skipped: warnings } };
  },
};
