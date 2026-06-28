import type {
  AgentProfile,
  RendererRegistry,
  StatusCallbacks,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  DEFAULT_MAX_ROUNDS,
  SessionGate,
  SessionScheduler,
  TaskGraph,
  ensureDir,
  loadProfilesFromDirs,
  parseJsonWithRepair,
  reviewRunner,
  schemaToString,
} from "@harms-haus/engin-engine";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PlanReadySchema, PlanSchema, PlanReviewSchema } from "./schemas";
import type { Plan } from "./schemas";

// ─── Plan artifact paths ───────────────────────────────────────────────────
//
// The planner writes its output as a JSON file under the run's `artifacts`
// directory rather than as a structured text response. A single source of
// truth for the path keeps the planner (which writes it), the orchestrator
// (which reads it back), and the plan-reviewer (which reviews it) in sync.

/** Directory holding durable artifacts for a run (created on demand). */
export function getArtifactsDir(workDir: string): string {
  return join(workDir, "artifacts");
}

/** Absolute path to the LIVE plan JSON artifact for a run — the file the
 *  planner writes/edits every round and the final approved plan. Rejected
 *  revisions are snapshotted to `plan-rev{N}.json` (see `snapshotPlan`), so
 *  `plan-final.json` always reflects the latest state. */
export function getPlanPath(workDir: string): string {
  return join(getArtifactsDir(workDir), "plan-final.json");
}

// ─── Phase 3: Planning ──────────────────────────────────────────────────────

/** Concise JSON example of the plan artifact shape (see PlanSchema for the full contract). */
const PLAN_SHAPE_EXAMPLE = `{
  "tasks": [
    {
      "id": "task-1",
      "title": "Short description of the task",
      "prompt": "Detailed prompt for the implementing agent",
      "profile": "implementer",
      "files": ["src/foo.ts"],
      "is_code": true,
      "dependencies": []
    }
  ],
  "strategy": "High-level implementation strategy"
}`;

/**
 * Read and validate the plan JSON artifact written by the planner.
 *
 * Returns `{ plan }` on success, or `{ error }` with a clear, actionable
 * message when the file is missing, unparseable, or fails `PlanSchema`
 * validation. Returning the error (rather than throwing) lets the orchestrator
 * surface it or fall back to the last captured plan.
 */
async function readAndValidatePlan(
  planPath: string,
): Promise<{ plan: Plan } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(planPath, "utf-8");
  } catch {
    return {
      error:
        `No plan file found at ${planPath}. You must use the \`write\` tool to create it ` +
        `(you are sandboxed to the artifacts directory).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithRepair(raw);
  } catch (err: unknown) {
    return {
      error:
        `The plan file at ${planPath} is not valid JSON: ` +
        (err instanceof Error ? err.message : String(err)),
    };
  }

  const result = PlanSchema.safeParse(parsed);
  if (!result.success) {
    return {
      error: `The plan file at ${planPath} failed schema validation: ${result.error.message}`,
    };
  }
  return { plan: result.data };
}

/**
 * Create an implementation plan based on the scouting research and task prompt.
 *
 * Unlike most agents, the planner does NOT respond with structured output.
 * Instead it WRITES its plan to a JSON artifact at `getPlanPath(workDir)` using
 * the `write` tool, confined by a write sandbox to the run's `artifacts`
 * directory.
 *
 * Plan + plan-review run as a `reviewRunner` (execute → review loop): the
 * planner writes plan-final.json (filesystem output mode) and the plan-reviewer
 * evaluates it (structured output `{ approved, feedback }`). When the reviewer
 * rejects, the reviewRunner appends the feedback to the planner prompt and
 * retries — up to `DEFAULT_MAX_ROUNDS` times. The runner is dispatched through
 * a `SessionScheduler` so the engine's hook pipeline (default auditor,
 * `beforeStepPrompt` file inlining, etc.) fires for every session.
 *
 * `graph` is the shared `TaskGraph` from the orchestrator. The planning task
 * is registered there with the reviewRunner factory as its runner. Planning
 * generates a PLAN ARTIFACT — the plan's tasks are NOT added to the graph;
 * implementation.ts consumes the plan and adds the real tasks.
 *
 * `files` is the list of key files the scouting review surfaced for this task.
 * They are threaded onto the planning task so the ENGINE's default
 * `beforeStepPrompt` / `collectContext` hooks inline them — eliminating any
 * local inlining duplication. `hookRegistry` must be threaded for that default
 * to actually fire.
 */
export async function planningPhase(
  graph: TaskGraph,
  profilesDirs: string[],
  research: string,
  files: string[],
  taskPrompt: string,
  cwd: string,
  workDir: string,
  apiKeys?: Record<string, string>,
  onStatus?: StatusCallbacks,
  signal?: AbortSignal,
  rendererRegistry?: RendererRegistry,
  hookRegistry?: WorkflowRunOptions["hookRegistry"],
): Promise<Plan> {
  const artifactsDir = getArtifactsDir(workDir);
  const planPath = getPlanPath(workDir);
  await ensureDir(artifactsDir);

  const planPrompt = buildPlanPrompt({
    taskPrompt,
    research,
    planPath,
    artifactsDir,
  });
  const reviewPrompt = buildPlanReviewPrompt({
    taskPrompt,
    research,
    planPath,
  });

  // Compose the execute (plan) → review (plan-review) loop. The planner uses
  // filesystem output mode (it writes plan-final.json via the `write` tool);
  // the reviewer uses structured output mode with PlanReviewSchema
  // ({ approved, feedback }). The reviewRunner owns the replan-on-rejection
  // loop internally — it checks `result.data.approved === true` and appends
  // feedback to the execute prompt on rejection.
  //
  // On rejection the just-written plan-final.json is COPIED to
  // plan-rev{round}.json so every rejected revision is preserved; the planner
  // then resumes and continues editing plan-final.json in place.
  const snapshotPlan = async (round: number): Promise<void> => {
    try {
      await copyFile(planPath, join(artifactsDir, `plan-rev${round}.json`));
    } catch {
      /* first round has nothing to snapshot yet, or copy failed — non-fatal */
    }
  };

  const runnerFactory = reviewRunner(
    {
      profile: "planner",
      prompt: planPrompt,
      // Structured output with a `plan_ready` done-signal. The planner still
      // writes the plan JSON file via the `write` tool; the structured response
      // is a self-certified completion gate. If the planner ends before writing
      // the file (or returns an invalid response), the engine's
      // `promptForStructured` re-prompts the SAME session with a targeted
      // reminder — catching "stopped early" at the source instead of letting a
      // silently-empty filesystem result flow to the plan-reviewer.
      outputMode: "structured",
      schema: PlanReadySchema,
      isReadOnly: false,
      // Confine writes to the run's artifacts dir only — the planner must not
      // touch the rest of the repo. Matches the prompt's explicit sandbox
      // statement. (The plan-reviewer below is read-only, so no sandbox.)
      allowedWriteDirs: [artifactsDir],
      role: "plan",
    },
    {
      profile: "plan-reviewer",
      prompt: reviewPrompt,
      outputMode: "structured",
      schema: PlanReviewSchema,
      isReadOnly: true,
      role: "review-plan",
    },
    { maxRounds: DEFAULT_MAX_ROUNDS, onReviewReject: snapshotPlan },
  );

  // Register the planning task in the shared graph. Scouting files are
  // threaded onto the task so the engine's default `beforeStepPrompt` hook
  // inlines them into both the planner and plan-reviewer prompts (no local
  // inlining duplication).
  graph.addTask(
    {
      id: "planning",
      title: "Plan & Review",
      prompt: taskPrompt,
      profile: "planner",
      files,
      dependencies: [],
      phaseId: "planning",
      worktree: "none",
      status: "ready",
    },
    runnerFactory,
  );

  // Build a SessionScheduler scoped to the planning phase. The scheduler owns
  // the gate and drives the planning task's reviewRunner to completion.
  const gate = new SessionGate({ total: 1, perModel: {} });
  const profiles: Map<string, AgentProfile> =
    await loadProfilesFromDirs(profilesDirs);

  const scheduler = new SessionScheduler({
    graph,
    gate,
    profiles,
    sessionBaseDir: join(workDir, "sessions", "planning"),
    cwd,
    ...(apiKeys !== undefined ? { apiKeys } : {}),
    ...(onStatus !== undefined ? { onStatus } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(rendererRegistry !== undefined ? { rendererRegistry } : {}),
    ...(hookRegistry !== undefined ? { hookRegistry } : {}),
    phaseId: "planning",
    activeSessions: new Set(),
  });

  const { completedTasks, failedTasks } = await scheduler.run();

  // Read back and validate the plan artifact. On review exhaustion (the
  // reviewer never approved) we proceed anyway with the latest plan —
  // mirroring the prior "exhausted rounds → proceed anyway" behaviour.
  const res = await readAndValidatePlan(planPath);
  if (!("plan" in res)) {
    throw new Error(res.error);
  }
  const validatedPlan = res.plan;

  // Surface the plan via onWorkflowData (replaces the old
  // tracker.setWorkflowData — the workflow store is now event-sourced).
  onStatus?.onWorkflowData?.({ data: { plan: validatedPlan } });

  // Surface the final review outcome for the TUI store. The durable AuditLog
  // equivalent is produced by the engine's default auditor (registered in
  // runSpir against the threaded hookRegistry), so no manual audit append
  // lives here.
  const approved = failedTasks === 0 && completedTasks > 0;
  onStatus?.onDecision?.({
    agentId: "plan-reviewer",
    decision: approved ? "plan_approved" : "plan_rejected",
    reasoning: "",
  });

  return validatedPlan;
}

// ─── Prompt builders ────────────────────────────────────────────────────────

/**
 * Build the planner prompt. Instructs the planner to write the plan as a JSON
 * file to `planPath` using the `write` tool, sandboxed to `artifactsDir`.
 *
 * Scouting file context is NOT inlined here — it is threaded onto the task's
 * `files` and inlined by the engine's default `beforeStepPrompt` hook.
 */
function buildPlanPrompt(opts: {
  taskPrompt: string;
  research: string;
  planPath: string;
  artifactsDir: string;
}): string {
  const promptLines: string[] = [
    "You are a planning agent. Based on the research below, create a detailed implementation plan.",
    "",
    `Task: ${opts.taskPrompt}`,
    "",
    "Research findings:",
    opts.research,
  ];

  promptLines.push(
    "",
    "Create a plan with specific tasks. Each task should be independently implementable.",
    "",
    "## How to deliver your plan",
    `You MUST write your plan as a JSON file at: \`${opts.planPath}\``,
    `Use the \`write\` tool to create that file. You are sandboxed: you may ONLY create or modify files under \`${opts.artifactsDir}\`. Any attempt to write elsewhere will be rejected.`,
    "Do NOT output the plan body as text in your response — write it to the file.",
    "",
    "## Completion signal (required)",
    "After you have successfully written the plan file, respond with ONLY this JSON object: `{ \"plan_ready\": true }`.",
    "Respond with `{ \"plan_ready\": false }` only if you genuinely cannot produce a plan.",
    "Do not send the signal until the file is written — the signal is how the workflow knows you finished.",
    "",
    "The JSON file must match this shape:",
    "```json",
    PLAN_SHAPE_EXAMPLE,
    "```",
    "Full schema:",
    "```",
    schemaToString(PlanSchema),
    "```",
  );

  return promptLines.join("\n");
}

/**
 * Build the plan-reviewer prompt. The reviewer is told where the planner wrote
 * the plan (`planPath`) and instructed to read and evaluate it.
 *
 * This prompt is built eagerly (before the reviewRunner executes the planner).
 * The plan file does not exist yet at build time — the reviewRunner runs the
 * planner first, then feeds the execute result into the review prompt. For
 * filesystem output mode the reviewRunner appends a note indicating the
 * planner wrote files; the reviewer reads `planPath` via its read tools.
 *
 * Scouting file context is NOT inlined here — same delegation path as the
 * planner prompt (task `files` → engine `beforeStepPrompt` hook).
 */
function buildPlanReviewPrompt(opts: {
  taskPrompt: string;
  research: string;
  planPath: string;
}): string {
  return [
    "You are reviewing an implementation plan. Evaluate it for completeness, correctness, and feasibility.",
    "",
    `Task: ${opts.taskPrompt}`,
    "",
    "Research context:",
    opts.research,
    "",
    `The planner has written the proposed plan to: \`${opts.planPath}\``,
    "Read that file and evaluate it carefully.",
    "",
    "Approve the plan if it's sound, or provide specific feedback for improvement.",
  ].join("\n");
}
