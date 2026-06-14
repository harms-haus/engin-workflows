import type { StatusCallbacks, StepDefinition, WorkflowStatusTracker } from "@harms-haus/engin";
import { LanePool, TaskTracker, runStepTask } from "@harms-haus/engin";
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
                    `Investigate the following area of the codebase:`,
                    "",
                    `Topic: ${topic.topic}`,
                    `Rationale: ${topic.rationale}`,
                    `Key files: ${topic.files.join(", ")}`,
                    "",
                    "Provide a detailed report of your findings.",
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
 */
export async function scoutingReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    reports: unknown[],
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
): Promise<ScoutingReview> {
    const prompt = [
        "You are reviewing scouting reports to determine if we have enough information to create an implementation plan.",
        "",
        "IMPORTANT: If the reports are NOT sufficient, your gaps list should ONLY contain the specific topics that are still missing or insufficiently covered. Do NOT re-list topics that are already adequately covered in the existing reports.",
        "",
        "Scouting reports:",
        JSON.stringify(reports, null, 2),
        "",
        "Determine if we're ready to plan. If not, identify ONLY the gaps that remain — each gap should include the topic name, why it still needs investigation, and the key files to examine.",
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
