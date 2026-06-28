import type {
  AuditLog,
  StepDefinition,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";

// ─── Workflow Configuration ─────────────────────────────────────────────────
//
// Encodes the differences between SPIR workflows (develop / improve / debug) as
// DATA, not boolean flags. Each workflow supplies its own WorkflowConfig; the
// shared backbone reads from it to drive behaviour.

/**
 * A specialized final-review dimension. The final review phase runs one
 * `FinalReviewerConfig` per dimension in parallel; each maps to an agent
 * profile (`profileId`) that knows how to assess that dimension.
 */
export interface FinalReviewerConfig {
  /** Agent profile id to load for this reviewer (e.g. 'efficiency-reviewer'). */
  profileId: string;
  /** Stable machine key for this dimension (e.g. 'efficiency', 'ui-ux'). Used to bucket review history across rounds. */
  dimension: string;
  /** Human-readable label shown in task titles / status (e.g. 'Efficiency'). */
  label: string;
}

export interface WorkflowConfig {
  name: string;
  defaultMaxConcurrentSessions: number;
  /**
   * Per-model concurrency limits applied by the SessionScheduler (the engine's
   * per-session scheduling primitive, constructed by the phase body modules).
   * When a model id is present, the scheduler caps how many concurrent
   * sessions use it. Omit (or pass `{}`) to let every model run unbounded
   * (the SessionScheduler's default).
   */
  modelConcurrency?: Record<string, number>;
  /**
   * Config-data describing the fix-and-verify steps for the final review's
   * fixer loop. Stored as plain `StepDefinition[]` (serializable config),
   * NOT as runtime runner objects; `final-review.ts` converts these into
   * `SessionPlanRunner`s at runtime when building each lane's fixer pool.
   */
  fixerSteps: StepDefinition[];
  /**
   * Specialized reviewers run in the final review phase. Each is invoked in
   * parallel every round. When omitted, `final-review.ts` falls back to
   * `DEFAULT_FINAL_REVIEWERS` (efficiency, code-quality, ui-ux, security).
   */
  finalReviewers?: FinalReviewerConfig[];
  phases: { id: string; label: string; icon: string }[];
  titleFormatter: (description: string) => string;
}

// ─── Run Options ────────────────────────────────────────────────────────────

export interface SpirRunOptions extends WorkflowRunOptions {
  /** Preferred: list of profile directories to load agent profiles from. */
  profilesDirs?: string[];
  /** Legacy singular form; normalized to `profilesDirs: [profilesDir]` by `normalizeOptions`. */
  profilesDir?: string;
  /** Optional AuditLog; when absent the backbone constructs one from `workDir`. */
  auditLog?: AuditLog;
}

// ─── Options Normalization ─────────────────────────────────────────────────

/**
 * Return a NEW `SpirRunOptions` with `profilesDirs` resolved and the legacy
 * singular `profilesDir` stripped. `profilesDirs` takes precedence; otherwise
 * a singular `profilesDir` (if present) is wrapped in an array. The input is
 * never mutated and no `any` cast is involved.
 */
export function normalizeOptions(options: SpirRunOptions): SpirRunOptions {
  const { profilesDir, profilesDirs, ...rest } = options;
  const resolved = profilesDirs ?? (profilesDir ? [profilesDir] : undefined);
  return resolved ? { ...rest, profilesDirs: resolved } : rest;
}
