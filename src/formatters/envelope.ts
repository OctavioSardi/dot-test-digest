import os from "node:os";
import type {
  Delta,
  DigestEnvelope,
  DigestStatus,
  ExecutionGear,
  FailureCluster,
  OutputFormat,
  TddPhase,
} from "../types/schema.js";

export const PASS_BYTE_CEILING = 160;
export const FAIL_BYTE_CEILING = 2400;
export const MAX_FAIL_TOKENS = 600;
const BYTES_PER_TOKEN = 4;
const MESSAGE_BYTE_CEILING = 240;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export function shortenPath(target: string): string {
  const home = os.homedir();
  return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

export function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const marker = "...";
  const sliced = buffer.subarray(0, Math.max(0, maxBytes - marker.length)).toString("utf8");
  return `${sliced.replace(/\uFFFD+$/, "")}${marker}`;
}

export interface BuildEnvelopeInput {
  status: DigestStatus;
  phase: TddPhase;
  exitCode: number;
  signal: string | null;
  gear: ExecutionGear;
  durationMs: number;
  counts: { passed: number; failed: number; skipped: number };
  clusters: readonly FailureCluster[];
  delta?: Delta;
  rawLogPath: string;
}

export function buildEnvelope(input: BuildEnvelopeInput): DigestEnvelope {
  return {
    status: input.status,
    tdd_phase: input.phase,
    exit_code: input.exitCode,
    signal: input.signal,
    execution_gear: input.gear,
    duration_ms: input.durationMs,
    summary: {
      passed: input.counts.passed,
      failed: input.counts.failed,
      skipped: input.counts.skipped,
      total_clusters: input.clusters.length,
    },
    ...(input.delta ? { delta: input.delta } : {}),
    ...(input.clusters.length > 0 ? { clusters: [...input.clusters] } : {}),
    raw_log_path: input.rawLogPath,
  };
}

function statusLabel(envelope: DigestEnvelope): string {
  return envelope.tdd_phase === "none"
    ? envelope.status
    : `${envelope.status} | ${envelope.tdd_phase.toUpperCase()}`;
}

function deltaFragment(envelope: DigestEnvelope): string {
  if (!envelope.delta) return "";
  return ` (delta: +${envelope.delta.newly_passing} newly passing, ${envelope.delta.newly_broken_regressions} regressions)`;
}

export function renderPassLine(envelope: DigestEnvelope): string {
  const line =
    `[${statusLabel(envelope)}] ${envelope.summary.passed} passed, ${envelope.summary.failed} failed` +
    `${deltaFragment(envelope)} in ${envelope.duration_ms}ms | log: ${shortenPath(envelope.raw_log_path)}`;
  return truncateBytes(line, PASS_BYTE_CEILING);
}

function renderCluster(cluster: FailureCluster): string {
  const rows: string[] = [
    `${cluster.cluster_id} ${cluster.error_kind} x${cluster.affected_count} ${cluster.top_frame}`,
  ];
  if (cluster.message !== "") rows.push(`  ${truncateBytes(cluster.message, MESSAGE_BYTE_CEILING)}`);
  if (cluster.diff) {
    rows.push(`  diff: expected ${cluster.diff.expected} / received ${cluster.diff.received}`);
  }
  for (const frame of cluster.pruned_stack) rows.push(`  ${frame}`);
  if (cluster.signal_window !== "") {
    for (const line of cluster.signal_window.split("\n")) rows.push(`  ${line}`);
  }
  if (cluster.sample_tests.length > 0) rows.push(`  tests: ${cluster.sample_tests.join(", ")}`);
  rows.push(`  raw: ${cluster.raw_log_lines}`);
  return rows.join("\n");
}

export function renderFailBody(envelope: DigestEnvelope): string {
  const clusters = envelope.clusters ?? [];
  let kept = clusters.length;

  const render = (): string => {
    const header =
      `[${statusLabel(envelope)}] ${envelope.summary.failed} failed, ${envelope.summary.passed} passed` +
      ` in ${envelope.duration_ms}ms | ${kept} cluster${kept === 1 ? "" : "s"}` +
      ` | log: ${shortenPath(envelope.raw_log_path)}`;
    const blocks = clusters.slice(0, kept).map(renderCluster).join("\n");
    const omission = kept < clusters.length ? `\n+${clusters.length - kept} more clusters (see log)` : "";
    return `${header}\n${blocks}${omission}`;
  };

  let text = render();
  while (estimateTokens(text) > MAX_FAIL_TOKENS && kept > 1) {
    kept -= 1;
    text = render();
  }
  return truncateBytes(text, FAIL_BYTE_CEILING);
}

export function formatEnvelope(envelope: DigestEnvelope, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(envelope, null, 2)}\n`;
  const oneLiner = envelope.status === "PASS" || envelope.status === "VALID_RED";
  return `${oneLiner ? renderPassLine(envelope) : renderFailBody(envelope)}\n`;
}
