import type { StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin";
import { createHarness, promptForStructured } from "@harms-haus/engin";
import { PlanSchema, PlanReviewSchema } from "./schemas";
import type { Plan, PlanReview } from "./schemas";
import { makeHarnessOptions, spawnAgent, structuredOutputEvent, decisionEvent } from "./helpers";

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
): Promise<Plan> {
    const opts = await makeHarnessOptions(profilesDirs, "planner", cwd, "planner", apiKeys, onStatus);
    const { session: harness, dispose: unsub } = await createHarness(opts);
    spawnAgent(tracker, onStatus, { agentId: "planner", profile: "planner", phase: "planning" });

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

    let plan: Plan;
    try {
        ({ result: plan } = await promptForStructured(harness, prompt, PlanSchema));
    } finally {
        unsub?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "planner", profile: "planner", phase: "planning" });

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
): Promise<PlanReview> {
    const opts = await makeHarnessOptions(profilesDirs, "plan-reviewer", cwd, "plan-reviewer", apiKeys, onStatus);
    const { session: harness, dispose: unsub } = await createHarness(opts);
    spawnAgent(tracker, onStatus, { agentId: "plan-reviewer", profile: "plan-reviewer", phase: "planning" });

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

    let review: PlanReview;
    try {
        ({ result: review } = await promptForStructured(harness, prompt, PlanReviewSchema));
    } finally {
        unsub?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "plan-reviewer", profile: "plan-reviewer", phase: "planning" });

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
