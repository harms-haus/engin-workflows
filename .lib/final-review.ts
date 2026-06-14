import type { StatusCallbacks, StepDefinition, WorkflowStatusTracker } from "@harms-haus/engin";
import { LanePool, TaskTracker, runStepTask } from "@harms-haus/engin";
import { join } from "node:path";
import { FinalReviewTopicsSchema } from "./schemas";
import type { FinalReviewTopics } from "./schemas";
import { structuredOutputEvent } from "./helpers";

// ─── Phase 6: Final Review ──────────────────────────────────────────────────

/**
 * Perform a final quality review of the entire implementation.
 * Spawns fixers for any issues found and loops until clean.
 */
export async function finalReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    cwd: string,
    workDir: string,
    maxConcurrentTasks: number | undefined,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
    fixerSteps: StepDefinition[] = [{ name: 'fix', profileId: 'fixer', isReadOnly: false }],
    titleFormatter: (description: string) => string = (d) => d.slice(0, 100),
): Promise<boolean> {
    const maxFixRounds = 3;
    let clean = false;

    for (let round = 0; round < maxFixRounds; round++) {
        // 1. Get final review assessment
        const reviewPrompt = [
            "You are performing a final quality review of the codebase.",
            "",
            "Examine the files and identify any remaining issues.",
        ].join("\n");

        const assessment = await runStepTask<FinalReviewTopics>({
            profilesDirs,
            phaseId: "review",
            taskId: `final-reviewer-round-${round}`,
            title: "Final Review",
            stepName: "final-review",
            profileId: "final-reviewer",
            cwd,
            apiKeys,
            onStatus,
            isReadOnly: true,
            schema: FinalReviewTopicsSchema,
            prompt: reviewPrompt,
            signal,
        });

        await tracker.auditLog.append(
            structuredOutputEvent("final-reviewer", assessment),
        );

        if (assessment.issues.length === 0) {
            clean = true;
            break;
        }

        // 2. Spawn fixers for critical issues
        const criticalIssues = assessment.issues.filter((issue) => issue.severity === "critical");
        if (criticalIssues.length === 0) {
            clean = true;
            break;
        }

        // Create fixer tasks and run via LanePool
        const fixerTracker = new TaskTracker();

        for (let i = 0; i < criticalIssues.length; i++) {
            const issue = criticalIssues[i];
            fixerTracker.addTask({
                id: `fixer-${i}`,
                title: `Fix: ${titleFormatter(issue.description)}`,
                prompt: [
                    "You are a fix agent. Resolve the following issue:",
                    "",
                    `File: ${issue.file}`,
                    `Issue: ${issue.description}`,
                    "",
                    "Apply the necessary fix.",
                ].join("\n"),
                profile: "fixer",
                files: [issue.file],
                dependencies: [],
                isCode: true,
                phaseId: 'review',
            });
        }

        const pool = new LanePool({
            maxConcurrentLanes: maxConcurrentTasks ?? 5,
            profilesDirs,
            sessionBaseDir: join(workDir, 'sessions', `fix-round-${round}`),
            cwd,
            apiKeys,
            onStatus,
            auditLog: tracker.auditLog,
            taskTracker: fixerTracker,
            getStepsForTask: () => fixerSteps,
            signal,
            phaseId: 'review',
        });

        await pool.run();

    }

    return clean;
}
