import type {
  AuditLog,
  StatusCallbacks,
  StepDefinition,
  TaskGraph,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  AuditLog as AuditLogCtor,
  SessionGate,
  SessionScheduler,
  TaskGraph as TaskGraphCtor,
  getDiff,
  linearRunner,
  loadProfilesFromDirs,
  singleSession,
} from "@harms-haus/engin-engine";
import { join } from "node:path";
import { runSingleSessionStructured } from "./session-utils.js";
import { FinalReviewResultSchema } from "./schemas";
import type {
  FinalReviewResult,
  FinalReviewFinding,
  FinalReviewSeverity,
} from "./schemas";
import type { FinalReviewerConfig } from "./config";
import { errorEvent } from "./helpers";

// ─── Phase 6: Multi-Dimensional Final Review (per-lane loops) ───────────────
//
// The final review runs several specialized reviewers IN PARALLEL as independent
// "lanes" (by default: efficiency, code-quality, ui-ux, security, documentation).
// Each lane runs its OWN focused loop over a single dimension:
//
//     review ──▶ (no actionable findings? done)
//               (actionable findings) ──▶ fixer ──▶ review-fixes ──┐
//                                          ▲                        │
//                                          └── still actionable? ───┘
//                                          (loop, up to MAX_FIX_ROUNDS fixer attempts)
//
// - The initial `review` and the `review-fixes` pass both use the SAME reviewer
//   profile for that lane; they differ only in prompt. The review-fixes pass is
//   verify-focused ("confirm your prior findings were resolved; report
//   unresolved ones and any new issues the fix introduced").
// - If the initial review is clean (no actionable findings), the fixer and
//   review-fixes passes are skipped entirely.
// - Each lane maintains its own per-dimension history (all prior review AND
//   review-fixes results) so the reviewer never re-reports already-fixed items.
// - Each lane owns its own fixer TaskGraph + SessionScheduler (findings from
//   other dimensions never mix in), and per-lane session directories keep fixer
//   sessions isolated.
//
// Each lane's review pass uses `runSingleSessionStructured` (shared from
// session-utils.ts) which wraps `singleSession` + a custom `runSession` to
// capture the structured `FinalReviewResult`. Per-lane fixer
// SessionSchedulers provide isolation for fix-and-verify loops.
//
// Fixer tasks are submitted to a per-lane TaskGraph whose runner factory is a
// `linearRunner` of `singleSession` wrappers (one per fixer step, built from
// `config.fixerSteps`). The SessionScheduler drives fixer execution through the
// session primitive instead of the legacy RunnerPool/getRunnerForTask path.
//
// The phase returns `true` only if EVERY lane finished clean.

/** Maximum fixer attempts per lane before giving up on that lane (clean=false). */
const MAX_FIX_ROUNDS = 3;

/**
 * Severity ratings that trigger a fixer task. Findings rated "low" are
 * recorded (audit-logged) but do NOT spawn fixers.
 */
const ACTIONABLE_SEVERITIES: readonly FinalReviewSeverity[] = [
  "medium",
  "high",
  "critical",
];

export function isActionableSeverity(severity: FinalReviewSeverity): boolean {
  return ACTIONABLE_SEVERITIES.includes(severity);
}

/**
 * Default set of specialized reviewers run in the final review phase when a
 * WorkflowConfig does not specify `finalReviewers`. Each entry maps to an agent
 * profile of the same `profileId` living in the workflow's `profiles/` dir.
 */
export const DEFAULT_FINAL_REVIEWERS: readonly FinalReviewerConfig[] = [
  {
    profileId: "efficiency-reviewer",
    dimension: "efficiency",
    label: "Efficiency",
  },
  {
    profileId: "code-quality-reviewer",
    dimension: "code-quality",
    label: "Code Quality",
  },
  { profileId: "ui-ux-reviewer", dimension: "ui-ux", label: "UI/UX" },
  { profileId: "security-reviewer", dimension: "security", label: "Security" },
  {
    profileId: "documentation-reviewer",
    dimension: "documentation",
    label: "Documentation",
  },
];

/**
 * Strip an optional `:line` / `:start-end` suffix from a file specifier so the
 * raw path can be used in the fixer task's `files` array
 * (e.g. `"src/auth.ts:42-58"` → `"src/auth.ts"`).
 */
function filePathOnly(spec: string): string {
  return spec.replace(/:\d+.*$/, "");
}

/** Return only the actionable (severity ≥ medium) findings from a result. */
function actionableFindings(result: FinalReviewResult): FinalReviewFinding[] {
  return result.applicable
    ? result.findings.filter((f) => isActionableSeverity(f.severity))
    : [];
}

/** Maximum characters of the git diff to inline into a reviewer prompt. */
const MAX_DIFF_CHARS = 60_000;

/**
 * Render the working-tree diff (against HEAD) as a prompt section so reviewers
 * see the exact changes without shelling out themselves. Called fresh before
 * each pass, so a review-fixes pass sees the post-fix state rather than a
 * stale snapshot.
 */
function formatDiffSection(diff: string): string {
  if (!diff) {
    return [
      "## Changes made during this workflow",
      "(No git diff was available — the working directory may not be a git repository, or there are no uncommitted changes against HEAD. Review the working tree directly.)",
    ].join("\n");
  }
  const truncated = diff.length > MAX_DIFF_CHARS;
  const body = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const lines = [
    "## Changes made during this workflow (git diff against HEAD)",
    "Review THESE changes through your dimension only — do not review the broader, unchanged codebase.",
    "```diff",
    body,
    "```",
  ];
  if (truncated) {
    lines.push(
      `(diff truncated to the first ${MAX_DIFF_CHARS} of ${diff.length} characters — use \`git diff HEAD\` to inspect the remainder)`,
    );
  }
  return lines.join("\n");
}

/** Build the prompt for a lane's INITIAL review pass. */
function buildReviewerPrompt(
  reviewer: FinalReviewerConfig,
  history: FinalReviewResult[],
  diff: string,
): string {
  const lines: string[] = [
    `You are performing the FINAL review of the codebase, focused on a single dimension: ${reviewer.label} (${reviewer.dimension}).`,
    "",
    "Review ALL changes made during this workflow through the lens of this dimension only, and report your findings. The complete diff of the changes is provided below.",
    "",
    formatDiffSection(diff),
    "",
    "OUTPUT RULES:",
    "- If this review dimension is NOT applicable to the changeset (for example: a UI/UX review when there are no UI-facing changes, or a security review when there is no security-relevant surface), set applicable=false, explain in notApplicableReason, and return an empty findings array.",
    "- Otherwise set applicable=true and list every real finding, ordered by severity (critical first).",
    "- Rate each finding: low (nit / cosmetic), medium (should fix), high (important), critical (must fix before merge).",
    "- For every finding, write a complete `fixPrompt` that a fixer agent can execute directly and in isolation to resolve it: state the file(s), the exact problem, and the intended fix. Do not reference other findings.",
    "- If there are genuinely no issues for this dimension, return applicable=true with an empty findings array — NEVER fabricate findings.",
    `- Set the \`dimension\` field of your response to exactly "${reviewer.dimension}".`,
  ];

  if (history.length > 0) {
    lines.push(
      "",
      `── PRIOR REVIEW HISTORY for ${reviewer.label} (ALL previous passes — do NOT re-report resolved findings) ──`,
      "",
      formatHistory(history),
      "",
      "This is a re-review. A previously-reported finding that has now been fixed must NOT be reported again. You may still report findings that were not adequately addressed, plus any NEW issues you notice.",
    );
  }

  return lines.join("\n");
}

/** Build the prompt for a lane's REVIEW-FIXES (verify) pass. */
function buildReviewFixesPrompt(
  reviewer: FinalReviewerConfig,
  history: FinalReviewResult[],
  fixRound: number,
  diff: string,
): string {
  const lines: string[] = [
    `You are performing the REVIEW-FIXES pass for the ${reviewer.label} (${reviewer.dimension}) dimension of the final review.`,
    "",
    "A fixer has just attempted to resolve the actionable findings you (or a prior pass) reported. The CURRENT diff (including the fix) is provided below. Re-assess it through this dimension ONLY, with two goals:",
    "",
    formatDiffSection(diff),
    "",
    "1. VERIFY the fixes: for each previously-reported actionable finding, confirm whether it was actually resolved. A finding that is now fixed must NOT be reported again.",
    "2. CATCH REGRESSIONS: report any NEW issues the fix introduced (e.g. the fix was incomplete, broke something else, or regressed this dimension), plus any previously-missed real issues.",
    "",
    "OUTPUT RULES:",
    "- If a finding is fully resolved, do not re-report it.",
    "- If a finding is only partially addressed or the fix is wrong, report it again (same or new id) with the remaining problem and an updated `fixPrompt`.",
    "- Rate each finding as before: low / medium / high / critical. Findings rated medium or higher will trigger another fixer attempt.",
    `- Set the \`dimension\` field of your response to exactly "${reviewer.dimension}".`,
    "- If every previously-reported finding is resolved and the fix introduced no new issues, return applicable=true with an empty findings array.",
  ];

  if (history.length > 0) {
    lines.push(
      "",
      `── PRIOR REVIEW HISTORY for ${reviewer.label} (initial review + prior review-fixes passes — do NOT re-report resolved findings) ──`,
      "",
      formatHistory(history),
      "",
      `This is review-fixes pass ${fixRound + 1}. Focus on confirming the fixes landed correctly and did not introduce regressions.`,
    );
  }

  return lines.join("\n");
}

/** Render a dimension's accumulated history as a human-readable block. */
function formatHistory(history: FinalReviewResult[]): string {
  const lines: string[] = [];
  history.forEach((prev, i) => {
    const passLabel = i === 0 ? "initial review" : `review-fixes pass ${i}`;
    lines.push(`### ${passLabel} — ${prev.summary}`);
    if (!prev.applicable) {
      lines.push(
        `Not applicable: ${prev.notApplicableReason || "(no reason given)"}`,
      );
      return;
    }
    if (prev.findings.length === 0) {
      lines.push("(no findings)");
      return;
    }
    for (const f of prev.findings) {
      lines.push(`- [${f.severity}] ${f.title} — ${f.file}`);
      lines.push(`    ${f.description}`);
    }
  });
  return lines.join("\n");
}

/** Shared, immutable context threaded into every review lane. */
interface LaneContext {
  profilesDirs: string[];
  cwd: string;
  workDir: string;
  maxConcurrentTasks: number | undefined;
  apiKeys?: Record<string, string>;
  onStatus?: StatusCallbacks;
  signal?: AbortSignal;
  fixerSteps: StepDefinition[];
  titleFormatter: (description: string) => string;
  /** Recomputes the working-tree diff (against HEAD); called fresh before each review pass. */
  collectDiff: () => string;
  /** Audit log for recording lane-level error events. Threaded into each
   *  per-lane fixer SessionScheduler so session events are tracked too. */
  auditLog: AuditLog;
  /** Threaded so the engine's default auditor observes each reviewer's structured_output. */
  hookRegistry?: WorkflowRunOptions["hookRegistry"];
}

/**
 * Run a per-lane fixer SessionScheduler over one set of actionable findings.
 * Each finding becomes one fixer task added to a FRESH per-lane TaskGraph; the
 * SessionScheduler runs them in parallel (bounded by `maxConcurrentSessions`).
 * Each task's runner factory is a `linearRunner` of `singleSession` wrappers
 * (one per fixer step), built from `ctx.fixerSteps`. The session dir is scoped
 * per dimension + fix round so concurrent lanes never collide.
 */
async function runFixersForLane(
  reviewer: FinalReviewerConfig,
  findings: FinalReviewFinding[],
  fixRound: number,
  ctx: LaneContext,
): Promise<void> {
  // Per-lane TaskGraph for fixer isolation (mirrors the original per-lane
  // TaskTracker). A fresh graph per lane+round ensures findings from other
  // dimensions or prior rounds never mix in.
  const laneGraph: TaskGraph = new TaskGraphCtor();

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    const taskId = `fixer-${reviewer.dimension}-${fixRound}-${i}`;
    const prompt = [
      "You are a fix agent. Resolve the following final-review finding.",
      "",
      `Review dimension: ${reviewer.label}`,
      `Severity: ${finding.severity}`,
      `File: ${finding.file}`,
      `Title: ${finding.title}`,
      "",
      "Finding:",
      finding.description,
      "",
      "Fix instructions (follow exactly; make targeted, minimal changes):",
      finding.fixPrompt,
    ].join("\n");

    // Build the runner factory: linearRunner of singleSession runners (one
    // SessionSpec per fixer step). `singleSession(spec)` returns a
    // SessionPlanFactory (() => SessionPlanRunner); calling it yields the
    // SessionPlanRunner. `linearRunner(SessionPlanRunner[])` returns a
    // SessionPlanFactory — the shape `taskGraph.addTask` expects for its
    // `runnerFactory` parameter.
    const runnerFactory = linearRunner(
      ctx.fixerSteps.map((step) =>
        singleSession({
          profile: step.profileId,
          prompt,
          outputMode: step.isReadOnly ? "text" : "filesystem",
          isReadOnly: step.isReadOnly,
          role: step.name,
          runnerRole: step.name,
          attempt: 1,
          ...(step.schema !== undefined ? { schema: step.schema } : {}),
        })(),
      ),
    );

    laneGraph.addTask(
      {
        id: taskId,
        title: `Fix [${finding.severity}] ${reviewer.label}: ${ctx.titleFormatter(finding.title)}`,
        prompt,
        profile: ctx.fixerSteps[0]?.profileId ?? "fixer",
        files: [filePathOnly(finding.file)],
        dependencies: [],
        status: "ready",
        phaseId: "review",
        worktree: "none",
      },
      runnerFactory,
    );
  }

  // ── Load profiles + build gate for the SessionScheduler ────────────
  const profiles = await loadProfilesFromDirs(ctx.profilesDirs);
  const gate = new SessionGate({
    total: ctx.maxConcurrentTasks ?? 5,
    perModel: {},
  });
  const activeSessions = new Set<{ abort(): Promise<void> }>();

  const scheduler = new SessionScheduler({
    graph: laneGraph,
    gate,
    profiles,
    sessionBaseDir: join(
      ctx.workDir,
      "sessions",
      `fix-${reviewer.dimension}-${fixRound}`,
    ),
    cwd: ctx.cwd,
    ...(ctx.apiKeys !== undefined ? { apiKeys: ctx.apiKeys } : {}),
    ...(ctx.onStatus !== undefined ? { onStatus: ctx.onStatus } : {}),
    ...(ctx.hookRegistry !== undefined
      ? { hookRegistry: ctx.hookRegistry }
      : {}),
    auditLog: ctx.auditLog,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    phaseId: "review",
    activeSessions,
  });

  await scheduler.run();
}

/**
 * Run a single reviewer lane to completion:
 *
 *   review ──▶ [fixer ──▶ review-fixes]*  (loop while actionable, ≤ MAX_FIX_ROUNDS fixes)
 *
 * Returns `true` if the lane ended clean (no actionable findings on its final
 * pass), `false` if it exhausted its fixer budget with findings still open.
 */
async function runFinalReviewLane(
  reviewer: FinalReviewerConfig,
  ctx: LaneContext,
): Promise<boolean> {
  const reviewSessionBaseDir = join(ctx.workDir, "sessions", "review");

  // Per-dimension history: the reviewer sees ALL of its own prior passes.
  const history: FinalReviewResult[] = [];

  // 1. Initial review pass.
  const reviewTaskId = `${reviewer.profileId}-round-0`;
  let result = await runSingleSessionStructured<FinalReviewResult>(
    {
      profile: reviewer.profileId,
      prompt: buildReviewerPrompt(reviewer, [], ctx.collectDiff()),
      schema: FinalReviewResultSchema,
      outputMode: "structured",
      isReadOnly: true,
      role: "final-review",
      runnerRole: "final-review",
      attempt: 1,
    },
    {
      profilesDirs: ctx.profilesDirs,
      cwd: ctx.cwd,
      sessionBaseDir: reviewSessionBaseDir,
      apiKeys: ctx.apiKeys,
      onStatus: ctx.onStatus,
      hookRegistry: ctx.hookRegistry,
      signal: ctx.signal,
      phaseId: "review",
      agentId: reviewer.profileId,
      taskId: reviewTaskId,
      taskTitle: `Final Review: ${reviewer.label}`,
    },
  );
  if (!result) {
    throw new Error(
      `Reviewer ${reviewer.profileId} did not produce structured output`,
    );
  }
  history.push(result);

  // No fixer / review-fixes if the lane is already clean.
  let pending = actionableFindings(result);
  if (pending.length === 0) return true;

  // 2. fixer → review-fixes loop (up to MAX_FIX_ROUNDS fixer attempts).
  for (let fixRound = 0; fixRound < MAX_FIX_ROUNDS; fixRound++) {
    await runFixersForLane(reviewer, pending, fixRound, ctx);

    const verifyTaskId = `${reviewer.profileId}-round-${fixRound + 1}`;
    const verify = await runSingleSessionStructured<FinalReviewResult>(
      {
        profile: reviewer.profileId,
        prompt: buildReviewFixesPrompt(
          reviewer,
          history,
          fixRound,
          ctx.collectDiff(),
        ),
        schema: FinalReviewResultSchema,
        outputMode: "structured",
        isReadOnly: true,
        role: "final-review-fixes",
        runnerRole: "final-review-fixes",
        attempt: 1,
      },
      {
        profilesDirs: ctx.profilesDirs,
        cwd: ctx.cwd,
        sessionBaseDir: reviewSessionBaseDir,
        apiKeys: ctx.apiKeys,
        onStatus: ctx.onStatus,
        hookRegistry: ctx.hookRegistry,
        signal: ctx.signal,
        phaseId: "review",
        agentId: reviewer.profileId,
        taskId: verifyTaskId,
        taskTitle: `Review Fixes: ${reviewer.label}`,
      },
    );
    if (!verify) {
      throw new Error(
        `Reviewer ${reviewer.profileId} did not produce structured output on review-fixes pass ${fixRound + 1}`,
      );
    }
    history.push(verify);

    pending = actionableFindings(verify);
    if (pending.length === 0) return true;
  }

  // Exhausted fixer budget for this lane with findings still open.
  return false;
}

/**
 * Perform the multi-dimensional final review of the entire implementation.
 *
 * Every reviewer in `finalReviewers` runs as an INDEPENDENT LANE in parallel.
 * Each lane loops `review → fixer → review-fixes` over its own dimension until
 * clean or until it exhausts `MAX_FIX_ROUNDS` fixer attempts. A lane whose
 * initial review is clean skips the fixer and review-fixes passes entirely.
 *
 * Per-lane review passes run through `runSingleSessionStructured` (shared from
 * session-utils.ts) which wraps `singleSession` + a custom `runSession` to
 * capture the structured `FinalReviewResult`.
 *
 * `graph` is the shared `TaskGraph` from the orchestrator — accepted for API
 * symmetry with the scouting/planning/implementation phases. Fixer tasks are
 * isolated in per-lane graphs (see `runFixersForLane`), so the shared graph is
 * not modified by this phase.
 *
 * Returns `true` only if every lane finished clean.
 */
export async function finalReviewPhase(
  graph: TaskGraph,
  profilesDirs: string[],
  cwd: string,
  workDir: string,
  maxConcurrentTasks: number | undefined,
  apiKeys?: Record<string, string>,
  onStatus?: StatusCallbacks,
  signal?: AbortSignal,
  finalReviewers: readonly FinalReviewerConfig[] = DEFAULT_FINAL_REVIEWERS,
  fixerSteps: StepDefinition[] = [
    { name: "fix", profileId: "fixer", isReadOnly: false },
  ],
  titleFormatter: (description: string) => string = (d) => d.slice(0, 100),
  hookRegistry?: WorkflowRunOptions["hookRegistry"],
): Promise<boolean> {
  // `graph` is the shared orchestrator TaskGraph — unused by this phase (fixer
  // tasks are isolated in per-lane graphs). Accepted for positional API
  // compatibility with the other phase bodies.
  void graph;

  const collectDiff = (): string => {
    try {
      return getDiff(cwd);
    } catch {
      return "";
    }
  };

  const auditLog: AuditLog = new AuditLogCtor(workDir);

  const ctx: LaneContext = {
    profilesDirs,
    cwd,
    workDir,
    maxConcurrentTasks,
    apiKeys,
    onStatus,
    signal,
    fixerSteps,
    titleFormatter,
    collectDiff,
    auditLog,
    hookRegistry,
  };

  // Run all lanes in parallel; the phase is clean iff every lane is clean.
  //
  // Each lane is ISOLATED so a single flaky reviewer cannot abort the whole
  // run. The most common lane failure is a structured-output failure — the
  // reviewer produced no JSON, so `runSingleSessionStructured` returns
  // `undefined` and the lane throws. Rather than letting that propagate and
  // fail the entire workflow, record the failure (audit + onError) and count
  // the lane as not-clean (false); the other lanes still run to completion.
  const results = await Promise.all(
    finalReviewers.map(async (reviewer) => {
      try {
        return await runFinalReviewLane(reviewer, ctx);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await ctx.auditLog.append(
          errorEvent(
            reviewer.profileId,
            `Review lane failed and was skipped: ${reason}`,
          ),
        );
        ctx.onStatus?.onError?.({
          agentId: reviewer.profileId,
          error: `Final review lane "${reviewer.label}" failed and was skipped: ${reason}`,
          phaseId: "review",
        });
        return false;
      }
    }),
  );

  return results.every(Boolean);
}
