import type {
  AuditLog,
  StatusCallbacks,
  TaskGraph,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  AuditLog as AuditLogCtor,
  SessionGate,
  SessionScheduler,
  linearRunner,
  loadProfilesFromDirs,
  singleSession,
} from "@harms-haus/engin-engine";
import { join } from "node:path";
import { runSingleSessionStructured } from "./session-utils.js";
import { ScoutingReviewSchema, ScoutingTopicSchema } from "./schemas";
import type { ScoutingReview, ScoutingTopics } from "./schemas";

// ─── Scouting step definitions ─────────────────────────────────────────────
//
// Each scout task runs a single "scouting" step via a read-only scout profile.
// Mapped (in the runnerFactory passed to taskGraph.addTask) to a linearRunner
// of singleSession runners — one SessionSpec per step — so the SessionScheduler
// drives scout execution through the session primitive instead of the legacy
// LanePool/getStepsForTask path.

interface ScoutingStep {
  name: string;
  profileId: string;
  isReadOnly: boolean;
}

const SCOUTING_STEPS: readonly ScoutingStep[] = [
  { name: "scouting", profileId: "scout", isReadOnly: true },
];

// ─── Phase 1: Scouting ──────────────────────────────────────────────────────

interface ScoutingTopic {
  topic: string;
  rationale: string;
  files: string[];
}

interface ScoutingPhaseOptions {
  /** Pre-defined topics (e.g. from a review's gaps). When provided, the scout-coordinator is skipped. */
  topics?: ScoutingTopic[];
  /** Round number for session directory naming (0-based). */
  round: number;
}

/**
 * Scout the codebase to identify key areas of investigation.
 *
 * When `options.topics` is provided, skips the scout-coordinator and runs a
 * SessionScheduler directly against those topics (used for follow-up rounds
 * after a review identifies gaps).
 *
 * When `options.topics` is omitted, runs the scout-coordinator first (via
 * `runSingleSessionStructured`) to determine the topics, then runs the
 * SessionScheduler (first round).
 *
 * Scout tasks are added to the SHARED `taskGraph` and the SessionScheduler runs
 * against it. Because the shared graph persists across the ≤3 scouting rounds,
 * complete scout-task results accumulate naturally, so the `onPhaseSettled`
 * hook registered in spir.ts can collect the cumulative set into
 * `state.scoutingReports` (and persist it to workflowData via
 * `onStatus.onWorkflowData`) once the phase settles.
 *
 * This function does NOT collect reports, call `onStatus.onWorkflowData`, or
 * fire `onAgentComplete` itself — collection/persistence is the hook's job,
 * and per-scout completion is already surfaced by the SessionScheduler's own
 * status callbacks (via `graph.onStatusTransition`), the same path
 * `implementationPhase` relies on.
 */
export async function scoutingPhase(
  taskGraph: TaskGraph,
  profilesDirs: string[],
  taskPrompt: string,
  cwd: string,
  maxConcurrentTasks: number = 5,
  workDir: string,
  apiKeys?: Record<string, string>,
  onStatus?: StatusCallbacks,
  signal?: AbortSignal,
  phaseOptions: ScoutingPhaseOptions = { round: 0 },
  hookRegistry?: WorkflowRunOptions["hookRegistry"],
): Promise<void> {
  let topics: ScoutingTopic[];

  if (phaseOptions.topics && phaseOptions.topics.length > 0) {
    // Follow-up round: use gaps from review directly
    topics = phaseOptions.topics;
  } else {
    // First round: use the scout-coordinator to determine topics
    const topicPrompt = [
      "You are a codebase scout. Analyze the task below and identify key areas of the codebase that need investigation.",
      "",
      `Task: ${taskPrompt}`,
    ].join("\n");

    const coordinatorSessionBaseDir = join(workDir, "sessions", "scouting");

    const coordinatorResult = await runSingleSessionStructured<ScoutingTopics>(
      {
        profile: "scout-coordinator",
        prompt: topicPrompt,
        schema: ScoutingTopicSchema,
        outputMode: "structured",
        isReadOnly: true,
        role: "coordinate",
        runnerRole: "coordinate",
        attempt: 1,
      },
      {
        profilesDirs,
        cwd,
        sessionBaseDir: coordinatorSessionBaseDir,
        apiKeys,
        onStatus,
        hookRegistry,
        signal,
        phaseId: "scouting",
        agentId: "scout-coordinator",
        taskId: "scout-coordinator",
        taskTitle: "Scout Coordinator",
      },
    );

    topics = coordinatorResult?.topics ?? [];
  }

  if (topics.length === 0) return;

  // Add scout tasks to the SHARED task graph (mirrors implementationPhase). The
  // `getTask` guard prevents a duplicate-add when a follow-up round's gap
  // repeats a prior topic slug — the shared graph accumulates scout tasks
  // across rounds, so a re-encountered id would otherwise throw.
  for (const topic of topics) {
    const taskId = `scout-${topic.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")}`;
    if (!taskGraph.getTask(taskId)) {
      const scoutPrompt = [
        "You are scouting ONE focused area of a codebase to support a larger task. Investigate YOUR assigned topic specifically, and relate everything you find back to why it matters for the task below.",
        "",
        "## Overall task (the goal this scouting supports)",
        taskPrompt,
        "",
        "## Your scouting topic (stay focused here — other scouts are covering the rest)",
        `Topic: ${topic.topic}`,
        `Rationale: ${topic.rationale}`,
        `Key files to start from: ${topic.files.join(", ")}`,
        "",
        "Provide a detailed report of your findings. For each finding, briefly note how it is relevant to the overall task. Do not duplicate work that falls outside your topic.",
      ].join("\n");

      // Build the runner factory: linearRunner of singleSession runners (one
      // SessionSpec per SCOUTING_STEPS step). singleSession returns a
      // SessionPlanFactory (() => SessionPlanRunner); calling it yields a
      // SessionPlanRunner. linearRunner wraps the SessionPlanRunner[] and
      // returns a SessionPlanFactory — the exact shape taskGraph.addTask
      // expects for its runnerFactory parameter.
      const runnerFactory = linearRunner(
        SCOUTING_STEPS.map((step) =>
          singleSession({
            profile: step.profileId,
            prompt: scoutPrompt,
            outputMode: "text",
            isReadOnly: step.isReadOnly,
            role: step.name,
            runnerRole: step.name,
            attempt: 1,
          })(),
        ),
      );

      taskGraph.addTask(
        {
          id: taskId,
          title: topic.topic,
          prompt: scoutPrompt,
          profile: "scout",
          files: topic.files,
          dependencies: [],
          status: "ready",
          phaseId: "scouting",
          worktree: "none",
        },
        runnerFactory,
      );
    }
  }

  // ── Load profiles + build gate for the SessionScheduler ────────────
  const profiles = await loadProfilesFromDirs(profilesDirs);
  const gate = new SessionGate({
    total: maxConcurrentTasks,
    perModel: {},
  });
  const auditLog: AuditLog = new AuditLogCtor(workDir);
  const activeSessions = new Set<{ abort(): Promise<void> }>();

  const scheduler = new SessionScheduler({
    graph: taskGraph,
    gate,
    profiles,
    sessionBaseDir: join(
      workDir,
      "sessions",
      `scouting-round-${phaseOptions.round}`,
    ),
    cwd,
    onStatus,
    hookRegistry,
    auditLog,
    signal,
    phaseId: "scouting",
    ...(apiKeys !== undefined ? { apiKeys } : {}),
    activeSessions,
  });

  await scheduler.run();
}

// ─── Phase 2: Scouting Review ───────────────────────────────────────────────

/**
 * Default ScoutingReview returned when the reviewer session does not produce
 * structured output (e.g. unit-test mocks). In production the structured path
 * always fires; this default keeps the contract total (never returns
 * `undefined`) and is conservative (ready=true so the workflow proceeds).
 */
const DEFAULT_REVIEW: ScoutingReview = {
  ready: true,
  research: "",
  gaps: [],
  files: [],
};

/**
 * Review the scouting reports and determine if we have enough information
 * to proceed to planning.
 *
 * The original task prompt is required: without it the reviewer cannot judge
 * whether the reports are sufficient *for this task*, and tends to invent
 * random gaps based on whatever it notices in the codebase.
 *
 * In addition to { ready, research, gaps }, the reviewer returns `files`: the
 * concrete key files a planner must read. The caller threads these into the
 * planning phase so the planner and plan-reviewer receive the file contents
 * directly instead of having to discover and read them themselves.
 */
export async function scoutingReviewPhase(
  taskGraph: TaskGraph,
  profilesDirs: string[],
  taskPrompt: string,
  reports: unknown[],
  cwd: string,
  apiKeys?: Record<string, string>,
  onStatus?: StatusCallbacks,
  signal?: AbortSignal,
  hookRegistry?: WorkflowRunOptions["hookRegistry"],
  /**
   * Run directory. When provided, the review session is persisted to
   * `{workDir}/sessions/scouting` for traceability; when absent
   * (e.g. unit tests), the session lands under `{cwd}/.engin/sessions`.
   */
  workDir?: string,
): Promise<ScoutingReview> {
  const prompt = [
    "You are reviewing scouting reports to determine if we have enough information to create an implementation plan FOR THE TASK BELOW.",
    "",
    "Task:",
    taskPrompt,
    "",
    "Scouting reports gathered so far:",
    JSON.stringify(reports, null, 2),
    "",
    "Your job:",
    "- Judge whether the reports above, taken together, give a planner enough understanding of the relevant parts of the codebase to write a complete implementation plan FOR THIS SPECIFIC TASK.",
    "- If yes: set ready=true, synthesize the reports into a coherent research summary, and set gaps to [].",
    "- If no: set ready=false and list ONLY the distinct areas that are still missing or insufficiently covered AND relevant to this task. Each gap must include the topic name, why it still needs investigation FOR THIS TASK, and the key files to examine. Do NOT re-list topics that the existing reports already cover adequately.",
    "- Every gap must be something a planner would actually need in order to plan the implementation of THIS task. Do NOT propose gaps that are merely interesting or tangentially related.",
    "- ALWAYS populate `files` with the concrete files a planner must open to write a precise plan for this task. Pull these from the reports (and the gaps, if any) — prefer specific file paths over directories, de-duplicate, and keep only files that are genuinely central to the task.",
    "- If the reports already cover everything needed to plan, you MUST return ready=true. Do not invent additional areas to scout just to be thorough.",
  ].join("\n");

  const sessionBaseDir = workDir
    ? join(workDir, "sessions", "scouting")
    : join(cwd, ".engin", "sessions", "scouting");

  const reviewData = await runSingleSessionStructured<ScoutingReview>(
    {
      profile: "scouting-reviewer",
      prompt,
      schema: ScoutingReviewSchema,
      outputMode: "structured",
      isReadOnly: true,
      role: "review-scouting",
      runnerRole: "review-scouting",
      attempt: 1,
    },
    {
      profilesDirs,
      cwd,
      sessionBaseDir,
      apiKeys,
      onStatus,
      hookRegistry,
      signal,
      phaseId: "scouting",
      agentId: "scouting-reviewer",
      taskId: "scouting-reviewer",
      taskTitle: "Scouting Review",
    },
  );

  const review: ScoutingReview = reviewData ?? DEFAULT_REVIEW;

  onStatus?.onDecision?.({
    agentId: "scouting-reviewer",
    decision: review.ready ? "proceed_to_planning" : "more_scouting_needed",
    reasoning: review.research,
  });

  return review;
}
