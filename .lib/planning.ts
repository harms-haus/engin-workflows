import type { RendererRegistry, StatusCallbacks, WorkflowRunOptions, WorkflowStatusTracker } from "@harms-haus/engin-engine";
import { ensureDir, parseJsonWithRepair, runMultiStepTask, schemaToString } from "@harms-haus/engin-engine";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PlanSchema, PlanReviewSchema } from "./schemas";
import type { Plan, PlanReview } from "./schemas";

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

/** Absolute path to the plan JSON artifact for a run. */
export function getPlanPath(workDir: string): string {
    return join(getArtifactsDir(workDir), "plan.json");
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
 * validation. Returning the error (rather than throwing) lets the planner's
 * `validateOutput` retry gate feed it back to the agent.
 */
async function readAndValidatePlan(planPath: string): Promise<{ plan: Plan } | { error: string }> {
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
        return { error: `The plan file at ${planPath} failed schema validation: ${result.error.message}` };
    }
    return { plan: result.data };
}

/**
 * Create an implementation plan based on the scouting research and task prompt.
 *
 * Unlike most agents, the planner does NOT respond with structured output.
 * Instead it WRITES its plan to a JSON artifact at `getPlanPath(workDir)` using
 * the `write` tool, confined by a write sandbox to the run's `artifacts`
 * directory. This function runs the planner, then reads and validates that
 * artifact back into a typed `Plan`.
 *
 * `files` is the list of key files the scouting review surfaced for this task.
 * Rather than inlining their contents locally (the old duplicated
 * per-file inlining path), they are handed to `runMultiStepTask` as
 * `files` on the task object so the ENGINE's default `beforeStepPrompt` /
 * `collectContext` hooks inline them — eliminating the duplicated inlining
 * logic. `hookRegistry` must be threaded for that default to actually fire.
 */
export async function planningPhase(
    tracker: WorkflowStatusTracker,
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

    const promptLines: string[] = [
        "You are a planning agent. Based on the research below, create a detailed implementation plan.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research findings:",
        research,
    ];

    promptLines.push(
        "",
        "Create a plan with specific tasks. Each task should be independently implementable.",
        "",
        "## How to deliver your plan",
        `You MUST write your plan as a JSON file at: \`${planPath}\``,
        `Use the \`write\` tool to create that file. You are sandboxed: you may ONLY create or modify files under \`${artifactsDir}\`. Any attempt to write elsewhere will be rejected.`,
        "Do NOT output the plan as text in your response — write it to the file. After writing it, reply with a single short line confirming the path.",
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

    const prompt = promptLines.join("\n");

    // Plan + plan-review run as TWO STEPS of ONE task (matching the
    // implementation phase's per-step-agent model). The review step gates the
    // plan step: when the reviewer rejects, runMultiStepTask backs up to the
    // plan step, appends the reviewer's feedback to the planner prompt, and
    // retries — up to maxStepRetries times. This single call therefore owns the
    // entire plan → review → replan loop (no orchestrator-level round counter).
    //
    // Step 1 (plan): the planner WRITES plan.json (no structured output). The
    // `validateOutput` gate reads it back, validates it against PlanSchema, and
    // on failure re-prompts the planner within the same session. The validated
    // plan is captured via closure.
    //
    // Step 2 (review-plan): the reviewer's prompt is a function evaluated at
    // run time, so it reads the plan artifact AFTER the planner has written it.
    // It approves / rejects via the PlanReview schema.
    let plan: Plan | undefined;
    const planStep = {
        stepName: "plan",
        profileId: "planner",
        prompt,
        isReadOnly: false,
        allowedWriteDirs: [artifactsDir],
        validateOutput: async () => {
            const res = await readAndValidatePlan(planPath);
            if ("plan" in res) {
                plan = res.plan;
                return;
            }
            return { error: res.error };
        },
    };

    const reviewStep = {
        stepName: "review-plan",
        profileId: "plan-reviewer",
        prompt: async () =>
            buildPlanReviewPrompt({ taskPrompt, research, planPath }),
        isReadOnly: true,
        schema: PlanReviewSchema,
        isApproved: (r: unknown) => (r as PlanReview).ready === true,
        getFeedback: (r: unknown) => {
            const rv = r as PlanReview;
            const parts = [rv.feedback];
            if (rv.suggestions && rv.suggestions.length > 0) {
                parts.push("Specific suggestions:", ...rv.suggestions.map((s) => `- ${s}`));
            }
            return parts.join("\n");
        },
    };

    const { results, approved } = await runMultiStepTask({
        profilesDirs,
        phaseId: "planning",
        taskId: "planning",
        title: "Plan & Review",
        steps: [planStep, reviewStep],
        cwd,
        apiKeys,
        onStatus,
        signal,
        rendererRegistry,
        // Thread the scouting files onto the task so the engine's default
        // `beforeStepPrompt` / `collectContext` hooks inline them into BOTH the
        // planner and plan-reviewer prompts (no local inlining duplication).
        // `hookRegistry` carries the default subscribers that actually fire it.
        files,
        hookRegistry,
        maxStepRetries: 3,
    });

    // The plan step's validateOutput gate guarantees `plan` is set once the
    // task reaches the review step. On exhaustion (review never approved) we
    // proceed anyway with the latest captured plan — mirroring the prior
    // "exhausted rounds → proceed anyway" behaviour.
    const validatedPlan: Plan =
        plan ?? (() => { throw new Error("Planning completed without a validated plan"); })();

    tracker.setWorkflowData({ plan: validatedPlan });

    // Surface the final review outcome for the TUI store. (Per-rejection
    // "step rejected" decisions are already fired by runMultiStepTask.) The
    // durable AuditLog equivalent is produced by the engine's default auditor
    // (registered in runSpir against the threaded hookRegistry), so no manual
    // audit append lives here.
    const finalReview = results[1] as PlanReview | undefined;
    const decision = approved ? "plan_approved" : "plan_rejected";
    const reasoning = finalReview?.feedback ?? "";
    onStatus?.onDecision?.({ agentId: "plan-reviewer", decision, reasoning });

    return validatedPlan;
}

// ─── Plan Review prompt builder ─────────────────────────────────────────────

/**
 * Build the plan-reviewer prompt. Reads the plan artifact the planner wrote
 * (`planPath`) at CALL time and inlines it verbatim, so the reviewer sees the
 * exact file currently on disk. This is why the review step's prompt is a
 * function evaluated lazily by `runMultiStepTask` rather than built up front:
 * the plan file does not exist until the planner step has run.
 *
 * Throws when no plan file exists yet (the plan step should have written it).
 */
async function buildPlanReviewPrompt(opts: {
    taskPrompt: string;
    research: string;
    planPath: string;
}): Promise<string> {
    let planText: string;
    try {
        planText = await readFile(opts.planPath, "utf-8");
    } catch {
        throw new Error(
            `Cannot review the plan: no plan file found at ${opts.planPath}. ` +
                `The planning phase must have written it first.`,
        );
    }

    const prompt = [
        "You are reviewing an implementation plan. Evaluate it for completeness, correctness, and feasibility.",
        "",
        `Task: ${opts.taskPrompt}`,
        "",
        "Research context:",
        opts.research,
    ];

    // NOTE: scouting file context is NOT inlined here. It is threaded onto the
    // task's `files` and inlined by the engine's default `beforeStepPrompt`
    // hook (same path as the planner prompt), so there is no local duplication.

    prompt.push(
        "",
        "Proposed plan (written by the planner):",
        "```json",
        planText.trim(),
        "```",
        "",
        "Approve the plan if it's sound, or provide specific feedback for improvement.",
    );

    return prompt.join("\n");
}
