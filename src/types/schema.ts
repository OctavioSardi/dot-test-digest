import { z } from "zod";

export const TddPhaseSchema = z.enum(["red", "green", "refactor", "none"]);
export type TddPhase = z.infer<typeof TddPhaseSchema>;

export const OutputFormatSchema = z.enum(["compact-md", "json"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

/**
 * R2: VALID_RED is required by SPEC §4.3 and CT-3 but missing from §4.1's enum.
 */
export const DigestStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "VALID_RED",
  "INVALID_RED",
  "REGRESSION_DETECTED",
  "BUILD_ERROR",
]);
export type DigestStatus = z.infer<typeof DigestStatusSchema>;

export const ExecutionGearSchema = z.enum([
  "GEAR_0_GRAMMAR",
  "GEAR_1_JEV",
  "GEAR_0_HEURISTIC_FALLBACK",
]);
export type ExecutionGear = z.infer<typeof ExecutionGearSchema>;

export const ErrorKindSchema = z.enum([
  "ASSERTION_FAILURE",
  "RUNTIME_EXCEPTION",
  "TYPE_COMPILE_ERROR",
  "SYNTAX_IMPORT_ERROR",
  "TIMEOUT_OR_CONN_REFUSED",
  "UNSTRUCTURED_BUILD_ERROR",
]);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const CliOptionsSchema = z.object({
  tddPhase: TddPhaseSchema.default("none"),
  format: OutputFormatSchema.default("compact-md"),
  maxClusters: z.number().int().min(1).max(15).default(5),
  contextLines: z.number().int().min(0).max(5).default(2),
  scopeId: z.string().min(1).max(64).optional(),
  noJev: z.boolean().default(false),
  retryFlakes: z.boolean().default(false),
});
export type CliOptions = z.infer<typeof CliOptionsSchema>;

/** R6: ≤5 repository frames + ≤1 external boundary frame. */
export const MAX_REPO_FRAMES = 5;
export const MAX_PRUNED_STACK = 6;

export const FailureClusterSchema = z.object({
  cluster_id: z.string().regex(/^c_[0-9a-f]{8}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  error_kind: ErrorKindSchema,
  affected_count: z.number().int().positive(),
  sample_tests: z.array(z.string()).max(3),
  diff: z.object({ expected: z.string(), received: z.string() }).optional(),
  message: z.string(),
  top_frame: z.string(),
  pruned_stack: z.array(z.string()).max(MAX_PRUNED_STACK),
  signal_window: z.string(),
  raw_log_lines: z.string().regex(/^L\d+-L\d+$/),
});
export type FailureCluster = z.infer<typeof FailureClusterSchema>;

export const SummarySchema = z.object({
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  total_clusters: z.number().int().min(0),
});

export const DeltaSchema = z.object({
  newly_passing: z.number().int().min(0),
  newly_broken_regressions: z.number().int().min(0),
  still_failing: z.number().int().min(0),
});
export type Delta = z.infer<typeof DeltaSchema>;

export const DigestEnvelopeSchema = z.object({
  status: DigestStatusSchema,
  tdd_phase: TddPhaseSchema,
  exit_code: z.number().int(),
  signal: z.string().nullable(),
  execution_gear: ExecutionGearSchema,
  duration_ms: z.number().int().min(0),
  summary: SummarySchema,
  delta: DeltaSchema.optional(),
  clusters: z.array(FailureClusterSchema).max(15).optional(),
  raw_log_path: z.string().min(1),
});
export type DigestEnvelope = z.infer<typeof DigestEnvelopeSchema>;

/* ------------------------------ Jev 1.13 wire ------------------------------ */
/* R1: real contract — POST /v1/systemone, lowercase type discriminators.     */

export const JevChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length <= 255, {
    message: "a Choice question accepts at most 255 options (INV-6)",
  }),
});

export const JevNoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }).optional(),
});

export const JevQuestionSchema = z.union([JevChoiceQuestionSchema, JevNoulQuestionSchema]);
export type JevQuestion = z.infer<typeof JevQuestionSchema>;

export const JevChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
});

export const JevNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

export const JevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([JevChoiceAnswerSchema, JevNoulAnswerSchema])),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
export type JevResponse = z.infer<typeof JevResponseSchema>;

export const JevRequestSchema = z.object({
  model: z.string(),
  state: z.union([z.string(), z.record(z.string(), z.unknown())]),
  questions: z.record(z.string(), JevQuestionSchema).refine((q) => Object.keys(q).length > 0, {
    message: "at least one question is required",
  }),
});
export type JevRequest = z.infer<typeof JevRequestSchema>;
