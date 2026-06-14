import type { StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin";
import { runStepTask } from "@harms-haus/engin";
import { PlanSchema, PlanReviewSchema } from "./schemas";
import type { Plan, PlanReview } from "./schemas";
import { structuredOutputEvent, decisionEvent } from "./helpers";

// ─── Phase 3: Planning ──────────────────────────────────────────────────────

/**
 * Create an implementation plan based on the scouting research and task prompt.
 */
export async function planningPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    research: string,
    taskPrompt: string,
    cwd: string,
    planReviewFeedback?: string,
    planReviewSuggestions?: string[],
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
): Promise<Plan> {
    const promptLines: string[] = [
        "You are a planning agent. Based on the research below, create a detailed implementation plan.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research findings:",
        research,
        "",
        "Create a plan with specific tasks. Each task should be independently implementable.",
    ];

    if (planReviewFeedback) {
        promptLines.push(
            "",
            "Previous plan was rejected. Address the following feedback:",
            planReviewFeedback,
        );
        if (planReviewSuggestions && planReviewSuggestions.length > 0) {
            promptLines.push(
                "",
                "Specific suggestions:",
                ...planReviewSuggestions.map(s => `- ${s}`),
            );
        }
    }

    const prompt = promptLines.join("\n");

    const plan = await runStepTask<Plan>({
        profilesDirs,
        phaseId: "planning",
        taskId: "planner",
        title: "Planner",
        stepName: "plan",
        profileId: "planner",
        cwd,
        apiKeys,
        onStatus,
        isReadOnly: true,
        schema: PlanSchema,
        prompt,
        signal,
    });

    tracker.setWorkflowData({ plan });

    await tracker.auditLog.append(
        structuredOutputEvent("planner", plan),
    );

    return plan;
}

// ─── Phase 4: Plan Review ───────────────────────────────────────────────────

/**
 * Review the plan and determine if it's ready for implementation.
 */
export async function planReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    plan: Plan,
    research: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
): Promise<PlanReview> {
    const prompt = [
        "You are reviewing an implementation plan. Evaluate it for completeness, correctness, and feasibility.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research context:",
        research,
        "",
        "Proposed plan:",
        JSON.stringify(plan, null, 2),
        "",
        "Approve the plan if it's sound, or provide specific feedback for improvement.",
    ].join("\n");

    const review = await runStepTask<PlanReview>({
        profilesDirs,
        phaseId: "planning",
        taskId: "plan-reviewer",
        title: "Plan Review",
        stepName: "review-plan",
        profileId: "plan-reviewer",
        cwd,
        apiKeys,
        onStatus,
        isReadOnly: true,
        schema: PlanReviewSchema,
        prompt,
        signal,
    });

    onStatus?.onDecision?.({
        agentId: "plan-reviewer",
        decision: review.ready ? "plan_approved" : "plan_rejected",
        reasoning: review.feedback,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "plan-reviewer",
            review.ready ? "plan_approved" : "plan_rejected",
            review.feedback,
        ),
    );

    return review;
}
