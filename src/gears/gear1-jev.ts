import { computeFingerprint } from "../pruner/cluster-dedup.js";
import type { CapturedLine } from "../runner/capture.js";
import type {
  ExecutionGear,
  FailureCluster,
  JevQuestion,
  JevResponse,
} from "../types/schema.js";
import { JevClient } from "./jev-client.js";
import {
  EXCERPT_PADDING,
  partitionWindows,
  selectCandidateWindows,
  type LogWindow,
} from "./windows.js";

export const FLAKE_PROBABILITY_THRESHOLD = 0.8;
export const MIN_UNSTRUCTURED_LINES = 151;
export const TAIL_STATE_LINES = 40;
const MESSAGE_CEILING = 240;

export const ERROR_CATEGORIES = {
  COMPILE_OR_LINK_ERROR: "Compiler or linker error in the project sources",
  MISSING_DEPENDENCY_OR_PACKAGE: "A library, package or system dependency is missing",
  ENV_OR_PORT_COLLISION: "Environment variable missing or a port/address is already in use",
  PERMISSION_OR_SECRET_MISSING: "Permission denied or credentials/secrets missing",
  TRANSIENT_NETWORK_OR_TIMEOUT: "Transient network timeout, DNS or rate-limit problem",
} as const;

export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

/** Anything that answers the two questions — `JevClient` in production, a stub in tests. */
export interface JevAsker {
  isConfigured(): boolean;
  ask(
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
  ): Promise<JevResponse>;
}

export interface Gear1Input {
  lines: readonly CapturedLine[];
  command: readonly string[];
  exitCode: number;
  repoRoot: string;
  contextLines: number;
  noJev: boolean;
  retryFlakes: boolean;
  client?: JevAsker;
}

export interface Gear1Outcome {
  gear: ExecutionGear;
  cluster: FailureCluster;
  retry: boolean;
  errorCategory: ErrorCategory | null;
}

const FILE_FRAME = /(\S+\.(?:c|cc|cpp|h|hpp|rs|go|ts|js|py|sh|nix|toml)):(\d+)(?::(\d+))?/;

function firstSalientLine(window: LogWindow): string {
  const lines = window.text.split("\n");
  const salient = /error|fatal|failed|panic|undefined reference|exception|not found/i;
  const hit = lines.find((line) => salient.test(line));
  const chosen = (hit ?? lines[0] ?? "unstructured failure").trim();
  return chosen.length > MESSAGE_CEILING ? `${chosen.slice(0, MESSAGE_CEILING)}...` : chosen;
}

function buildCluster(window: LogWindow, lines: readonly CapturedLine[]): FailureCluster {
  const startLine = Math.max(1, window.startLine - EXCERPT_PADDING);
  const lastLine = lines[lines.length - 1]?.line ?? window.endLine;
  const endLine = Math.min(lastLine, window.endLine + EXCERPT_PADDING);
  const excerpt = lines
    .filter((line) => line.line >= startLine && line.line <= endLine)
    .map((line) => line.text)
    .join("\n");

  const frame = FILE_FRAME.exec(window.text);
  const topFrame = frame?.[2] !== undefined ? `${frame[1]}:${frame[2]}:${frame[3] ?? "1"}` : "unknown:0:0";
  const message = firstSalientLine(window);
  const fingerprint = computeFingerprint("UNSTRUCTURED_BUILD_ERROR", topFrame, message);

  return {
    cluster_id: `c_${fingerprint.slice(0, 8)}`,
    fingerprint,
    error_kind: "UNSTRUCTURED_BUILD_ERROR",
    affected_count: 1,
    sample_tests: [],
    message,
    top_frame: topFrame,
    pruned_stack: [],
    signal_window: excerpt,
    raw_log_lines: `L${startLine}-L${endLine}`,
  };
}

function heuristicWindow(windows: readonly LogWindow[]): LogWindow {
  const ranked = [...windows].sort(
    (a, b) => b.score - a.score || b.startLine - a.startLine,
  );
  return ranked[0] ?? {
    id: "w_1",
    startLine: 1,
    endLine: 1,
    score: 0,
    text: "unstructured failure",
  };
}

export async function triageUnstructured(input: Gear1Input): Promise<Gear1Outcome> {
  const windows = partitionWindows(input.lines);
  const candidates = selectCandidateWindows(windows);
  const client = input.client ?? new JevClient();

  const fallback = (): Gear1Outcome => {
    const window = heuristicWindow(windows.length > 0 ? windows : candidates);
    return {
      gear: "GEAR_0_HEURISTIC_FALLBACK",
      cluster: buildCluster(window, input.lines),
      retry: false,
      errorCategory: null,
    };
  };

  if (input.noJev || !client.isConfigured() || candidates.length === 0) return fallback();

  const criteria: Record<string, string> = {};
  for (const window of candidates) criteria[window.id] = window.text;

  const questions: Record<string, JevQuestion> = {
    root_cause_window: {
      type: "choice",
      instructions:
        "Which window contains the primary root cause of this build failure? " +
        "Ignore downstream cascading wrapper errors such as 'make: *** [all] Error 2'.",
      criteria,
    },
    error_category: {
      type: "choice",
      instructions: "Which category best describes the primary root cause?",
      criteria: { ...ERROR_CATEGORIES },
    },
    is_transient_flake: {
      type: "noul",
      instructions:
        "This failure is caused by a transient network timeout, port lock or race condition " +
        "that warrants one automatic retry.",
      criteria: {
        true: "A timeout, port already in use, DNS failure or rate limit",
        false: "A deterministic compile, link, dependency or permission error",
      },
    },
  };

  const state = {
    command: input.command.join(" "),
    exit_code: input.exitCode,
    log_lines: input.lines.length,
    tail: input.lines
      .slice(-TAIL_STATE_LINES)
      .map((line) => line.text)
      .join("\n"),
  };

  let response: JevResponse;
  try {
    response = await client.ask(state, questions);
  } catch {
    return fallback();
  }

  const rootCause = response.answers["root_cause_window"];
  const chosenId = rootCause?.type === "choice" ? rootCause.choice : null;
  const window = candidates.find((candidate) => candidate.id === chosenId) ?? heuristicWindow(windows);

  const category = response.answers["error_category"];
  const errorCategory =
    category?.type === "choice" && category.choice in ERROR_CATEGORIES
      ? (category.choice as ErrorCategory)
      : null;

  const flake = response.answers["is_transient_flake"];
  const retry =
    input.retryFlakes &&
    flake?.type === "noul" &&
    flake.noul >= FLAKE_PROBABILITY_THRESHOLD;

  return {
    gear: "GEAR_1_JEV",
    cluster: buildCluster(window, input.lines),
    retry,
    errorCategory,
  };
}
