import type { StatusCallbacks, StepDefinition, WorkflowStatusTracker } from "@harms-haus/engin-engine";
import { LanePool, TaskTracker, runStepTask } from "@harms-haus/engin-engine";
import { join } from "node:path";
import { ScoutingTopicSchema, ScoutingReviewSchema } from "./schemas";
import type { ScoutingTopics, ScoutingReview } from "./schemas";
import { structuredOutputEvent, decisionEvent } from "./helpers";

// ─── Phase 1: Scouting ──────────────────────────────────────────────────────

interface ScoutingTopic {
    topic: string;
    rationale: string;
    files: string[];
}

interface ScoutingPhaseOptions {
    /** Pre-defined topics (e.g. from a review's gaps). When provided, the scout-coordinator is skipped. */
    topics?: ScoutingTopic[];
    /** Previous scouting reports to accumulate into (new reports are appended). */
    existingReports?: unknown[];
    /** Round number for session directory naming (0-based). */
    round: number;
}

/**
 * Scout the codebase to identify key areas of investigation.
 *
 * When `options.topics` is provided, skips the scout-coordinator and runs a
 * LanePool directly against those topics (used for follow-up rounds after a
 * review identifies gaps).
 *
 * When `options.topics` is omitted, runs the scout-coordinator first to
 * determine the topics, then runs the LanePool (first round).
 *
 * New reports are appended to `options.existingReports` when provided.
 * Returns the complete accumulated list of reports.
 */
export async function scoutingPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    maxConcurrentTasks: number = 5,
    workDir: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
    phaseOptions: ScoutingPhaseOptions = { round: 0 },
): Promise<unknown[]> {
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

        const coordinatorTopics = await runStepTask<ScoutingTopics>({
            profilesDirs,
            phaseId: "scouting",
            taskId: "scout-coordinator",
            title: "Scout Coordinator",
            stepName: "coordinate",
            profileId: "scout-coordinator",
            cwd,
            apiKeys,
            onStatus,
            isReadOnly: true,
            schema: ScoutingTopicSchema,
            prompt: topicPrompt,
            signal,
        });

        topics = coordinatorTopics.topics;

        await tracker.auditLog.append(
            structuredOutputEvent("scout-coordinator", coordinatorTopics),
        );
    }

    // Run LanePool with the determined topics
    const reports: unknown[] = phaseOptions.existingReports
        ? [...phaseOptions.existingReports]
        : [];

    if (topics.length > 0) {
        const scoutingTracker = new TaskTracker();

        for (const topic of topics) {
            const taskId = `scout-${topic.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
            scoutingTracker.addTask({
                id: taskId,
                title: topic.topic,
                prompt: [
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
                ].join("\n"),
                profile: "scout",
                files: topic.files,
                dependencies: [],
                isCode: false,
                phaseId: "scouting",
            });
        }

        const SCOUTING_STEPS: StepDefinition[] = [
            { name: 'scouting', profileId: 'scout', isReadOnly: true },
        ];

        const pool = new LanePool({
            maxConcurrentLanes: maxConcurrentTasks,
            profilesDirs,
            phaseId: "scouting",
            sessionBaseDir: join(workDir, 'sessions', `scouting-round-${phaseOptions.round}`),
            cwd,
            apiKeys,
            onStatus,
            auditLog: tracker.auditLog,
            taskTracker: scoutingTracker,
            getStepsForTask: () => SCOUTING_STEPS,
            signal,
        });

        await pool.run();

        // Collect results from completed tasks and APPEND to existing reports
        for (const task of scoutingTracker.getAllTasks()) {
            if (task.status === 'complete') {
                reports.push(task.result);
                onStatus?.onAgentComplete?.({ agentId: task.id, profile: "scout", phaseId: "scouting" });
            }
        }
    }

    // Update tracker with the full accumulated reports
    tracker.setWorkflowData({ scoutingReports: reports });

    return reports;
}

// ─── Phase 2: Scouting Review ───────────────────────────────────────────────

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
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    taskPrompt: string,
    reports: unknown[],
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
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

    const review = await runStepTask<ScoutingReview>({
        profilesDirs,
        phaseId: "scouting",
        taskId: "scouting-reviewer",
        title: "Scouting Review",
        stepName: "review-scouting",
        profileId: "scouting-reviewer",
        cwd,
        apiKeys,
        onStatus,
        isReadOnly: true,
        schema: ScoutingReviewSchema,
        prompt,
        signal,
    });

    onStatus?.onDecision?.({
        agentId: "scouting-reviewer",
        decision: review.ready ? "proceed_to_planning" : "more_scouting_needed",
        reasoning: review.research,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "scouting-reviewer",
            review.ready ? "proceed_to_planning" : "more_scouting_needed",
            review.research,
        ),
    );

    return review;
}
