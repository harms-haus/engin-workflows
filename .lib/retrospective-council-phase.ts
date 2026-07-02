import type {
  AgentProfile,
  AuditLog,
  SessionPlanContext,
  SessionResult,
  SessionSpec,
  StatusCallbacks,
  StepDefinition,
  TaskGraph,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  AuditLog as AuditLogCtor,
  SessionGate,
  SessionScheduler,
  getDiff,
  loadProfilesFromDirs,
  retrospectiveCouncilRunner,
} from "@harms-haus/engin-engine";
import { join } from "node:path";
import { FinalReviewResultSchema, RetrospectiveDecisionSchema } from "./schemas";
import type {
  FinalReviewFinding,
  FinalReviewResult,
  RetrospectiveDecision,
} from "./schemas";
import type { FinalReviewerConfig } from "./config";
import { errorEvent } from "./helpers";
import {
  actionableFindings,
  buildReviewFixesPrompt,
  buildReviewerPrompt,
  isActionableSeverity,
} from "./final-review";

// ─── Retrospective Council Review Phase ────────────────────────────────────
//
// Replaces {@link finalReviewPhase} when `reviewStrategy === 'council'`.
//
// Instead of per-lane review→fix→verify LOOPS driven by per-lane
// SessionSchedulers (each with its OWN gate), this phase builds ONE shared
// {@link SessionGate} seeded from `modelConcurrency` and ONE
// {@link SessionScheduler} that drives ALL review dimensions in parallel as
// independent {@link TaskGraph} tasks.
//
// Each dimension is a single task whose runner is a
// {@link retrospectiveCouncilRunner}:
//
//   convener → buildMembers(fixers) → retrospective → interpretRetrospective →
//     (terminate? done : buildMembers(next fixers)) → retrospective → ...
//
// The convener is the INITIAL review pass. buildMembers converts actionable
// findings into fixer sessions. The retrospective is the REVIEW-FIXES pass.
// interpretRetrospective decides whether to terminate or produce another
// batch of fixer sessions for the next round.
//
// ── The bug fix ──
//
// The legacy per-lane design created a SessionGate per lane with
// `perModel: {}`, so fixer sessions BYPASSED model concurrency caps entirely.
// This phase uses ONE shared gate with `perModel: modelConcurrency`, so every
// review + fixer session across every dimension respects the configured caps.

/**
 * Build the fixer prompt text for a single finding (mirrors the exact
 * construction inlined in `runFixersForLane` in final-review.ts).
 */
function buildFixerPromptText(
  finding: FinalReviewFinding,
  label: string,
): string {
  return [
    "You are a fix agent. Resolve the following final-review finding.",
    "",
    `Review dimension: ${label}`,
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
}

/**
 * Perform the multi-dimensional final review using the retrospective-council
 * runner pattern.
 *
 * Builds 5 (one per `finalReviewers` entry) PARALLEL {@link TaskGraph} tasks,
 * each driven by a {@link retrospectiveCouncilRunner}, ALL sharing ONE
 * {@link SessionGate} (seeded from `modelConcurrency`) and ONE
 * {@link SessionScheduler}.
 *
 * Returns `true` only if the scheduler completes with zero failed tasks.
 */
export async function retrospectiveCouncilPhase(
  graph: TaskGraph,
  profilesDirs: string[],
  cwd: string,
  workDir: string,
  maxConcurrentTasks: number,
  apiKeys: Record<string, string> | undefined,
  onStatus: StatusCallbacks | undefined,
  signal: AbortSignal | undefined,
  finalReviewers: readonly FinalReviewerConfig[],
  fixerSteps: StepDefinition[],
  titleFormatter: (description: string) => string,
  hookRegistry: WorkflowRunOptions["hookRegistry"] | undefined,
  modelConcurrency: Record<string, number>,
  maxCouncilRounds: number,
): Promise<boolean> {
  // ── 1. Load profiles ────────────────────────────────────────────────
  const profiles: Map<string, AgentProfile> =
    await loadProfilesFromDirs(profilesDirs);

  // ── 2. Audit log ────────────────────────────────────────────────────
  const auditLog: AuditLog = new AuditLogCtor(workDir);

  // ── 3. Diff collector (fresh each call) ─────────────────────────────
  const collectDiff = async (): Promise<string> => {
    try {
      return await getDiff(cwd);
    } catch {
      return "";
    }
  };

  // ── 4. THE BUG FIX — ONE shared gate seeded from modelConcurrency ──
  const gate = new SessionGate({
    total: maxConcurrentTasks,
    perModel: modelConcurrency,
  });

  // ── 5. Per-dimension task + runnerFactory ───────────────────────────
  for (const reviewer of finalReviewers) {
    const { dimension, label, profileId } = reviewer;

    // Per-dimension closure state (captured by reference in the closures
    // below). Each `reviewer` iteration gets its own fresh history/round.
    let history: FinalReviewResult[] = [];
    let round = 1;

    // ── Convener SessionSpec (initial review pass) ───────────────────
    // The convener runs once before any fixes, so one fresh diff is correct.
    const initialDiff = await collectDiff();
    const convener: SessionSpec = {
      id: `${dimension}-convener`,
      profile: profileId,
      prompt: buildReviewerPrompt(reviewer, [], initialDiff),
      outputMode: "structured",
      schema: FinalReviewResultSchema,
      runnerRole: "convener",
      attempt: 1,
      isReadOnly: true,
    };

    // ── buildMembers: convert convener result into fixer sessions ────
    const buildMembers = (convenerResult: SessionResult): SessionSpec[] => {
      if (convenerResult.mode !== "structured") return [];
      const result = convenerResult.data as FinalReviewResult;
      history.push(result);
      if (result.applicable === false) return [];
      const findings = actionableFindings(result);
      return findings.map(
        (finding, i): SessionSpec => ({
          id: `${dimension}-fix-r${round}-${i}`,
          profile: fixerSteps[0]?.profileId ?? "fixer",
          prompt: buildFixerPromptText(finding, label),
          outputMode: "filesystem",
          runnerRole: "fixer",
          attempt: 1,
          isReadOnly: false,
        }),
      );
    };

    // ── Retrospective TEMPLATE SessionSpec ───────────────────────────
    const retrospective: SessionSpec = {
      id: `${dimension}-retrospective`,
      profile: profileId,
      prompt: "",
      outputMode: "structured",
      schema: RetrospectiveDecisionSchema,
      runnerRole: "retrospective",
      attempt: 1,
      isReadOnly: true,
    };

    // ── buildRetrospectivePrompt: fresh diff each round ──────────────
    const buildRetrospectivePrompt = async (
      _ctx: SessionPlanContext,
      r: number,
    ): Promise<string> => {
      const diff = await collectDiff();
      return buildReviewFixesPrompt(reviewer, history, r - 1, diff);
    };

    // ── interpretRetrospective: decide terminate or next fixers ──────
    const interpretRetrospective = (
      retroResult: SessionResult,
    ): { terminate: boolean; nextMembers: SessionSpec[] } => {
      if (retroResult.mode !== "structured") {
        return { terminate: true, nextMembers: [] };
      }
      const decision = retroResult.data as RetrospectiveDecision;

      // Push a FinalReviewResult-shaped entry to history so the next
      // retrospective prompt's formatHistory renders prior findings.
      history.push({
        dimension,
        applicable: decision.applicable,
        notApplicableReason: "",
        summary: decision.summary,
        findings: [...decision.findings, ...decision.regressions],
      });

      round++;

      if (decision.applicable === false) {
        return { terminate: true, nextMembers: [] };
      }

      const remaining = decision.findings
        .concat(decision.regressions)
        .filter((f) => isActionableSeverity(f.severity));

      const nextMembers = remaining.map(
        (finding, i): SessionSpec => ({
          id: `${dimension}-fix-r${round}-${i}`,
          profile: fixerSteps[0]?.profileId ?? "fixer",
          prompt: buildFixerPromptText(finding, label),
          outputMode: "filesystem",
          runnerRole: "fixer",
          attempt: 1,
          isReadOnly: false,
        }),
      );

      return {
        terminate: decision.terminate || remaining.length === 0,
        nextMembers,
      };
    };

    // ── onMaxRoundsExhausted: audit + status (mirror final-review.ts) ─
    const onMaxRoundsExhausted = async (): Promise<void> => {
      const msg = `Dimension "${label}" exhausted maxCouncilRounds (${maxCouncilRounds}) with findings remaining`;
      try {
        await auditLog.append(errorEvent(profileId, msg));
      } catch {
        /* best-effort */
      }
      onStatus?.onError?.({
        agentId: profileId,
        error: msg,
        phaseId: "review",
      });
    };

    // ── runnerFactory: retrospectiveCouncilRunner → SessionPlanRunner ─
    const runnerFactory = () =>
      retrospectiveCouncilRunner({
        convener,
        buildMembers,
        retrospective,
        buildRetrospectivePrompt,
        interpretRetrospective,
        maxRounds: maxCouncilRounds,
        onMaxRoundsExhausted,
      })();

    // ── 6. graph.addTask per dimension ────────────────────────────────
    graph.addTask(
      {
        id: `review-${dimension}`,
        title: titleFormatter(`Review: ${label}`),
        prompt: `${label} council review`,
        profile: profileId,
        files: [],
        dependencies: [],
        status: "ready",
        phaseId: "review",
        worktree: "none",
      },
      runnerFactory,
    );
  }

  // ── 7. ONE shared scheduler + run ───────────────────────────────────
  const activeSessions = new Set<{ abort(): Promise<void> }>();

  const scheduler = new SessionScheduler({
    graph,
    gate,
    profiles,
    sessionBaseDir: join(workDir, "sessions"),
    cwd,
    onStatus,
    hookRegistry,
    auditLog,
    signal,
    phaseId: "review",
    ...(apiKeys !== undefined ? { apiKeys } : {}),
    activeSessions,
  });

  const { failedTasks } = await scheduler.run();

  // ── 8. POST-RUN: emit errors for failed tasks ──────────────────────
  if (failedTasks > 0) {
    for (const entry of graph.getAllTasks()) {
      if (entry.status === "failed") {
        const msg = `Review task failed: ${entry.task.id}`;
        onStatus?.onError?.({
          agentId: "review",
          error: msg,
          phaseId: "review",
        });
        try {
          await auditLog.append(errorEvent("review", msg));
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return failedTasks === 0;
}
