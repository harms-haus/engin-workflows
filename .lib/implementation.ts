import type { StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin";
import { LanePool } from "@harms-haus/engin";
import type { Plan } from "./schemas";
import { CODE_STEPS, NON_CODE_STEPS } from "./steps";
import { join } from "node:path";

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the tracker
 * 2. Claiming and dispatching tasks to implementers
 * 3. Reviewing completed tasks
 * 4. Accepting or rejecting based on review
 */
export async function implementationPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    plan: Plan,
    cwd: string,
    maxConcurrentTasks: number = 5,
    workDir: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
): Promise<void> {
    // 1. Load plan tasks into the tracker
    for (const task of plan.tasks) {
        if (!tracker.taskTracker.getTask(task.id)) {
            tracker.taskTracker.addTask({
                id: task.id,
                title: task.title,
                prompt: task.prompt,
                profile: task.profile,
                files: task.files,
                dependencies: task.dependencies,
                isCode: task.is_code,
                phaseId: 'implementing',
            });
        }
    }

    // Validate that all dependency references are valid
    tracker.taskTracker.validateAllDependencies();

    // 2. Create and run the lane pool
    const pool = new LanePool({
        maxConcurrentLanes: maxConcurrentTasks,
        profilesDirs,
        phaseId: 'implementing',
        sessionBaseDir: join(workDir, 'sessions'),
        cwd,
        apiKeys,
        onStatus,
        auditLog: tracker.auditLog,
        taskTracker: tracker.taskTracker,
        getStepsForTask: (task) => {
            const steps = task.isCode !== false ? CODE_STEPS : NON_CODE_STEPS;
            // If the task specifies a non-default implementer profile (e.g. 'implementer-lite'),
            // substitute it into the execute step while keeping reviewer steps unchanged.
            if (task.profile && task.profile !== 'implementer') {
                return steps.map(step =>
                    step.profileId === 'implementer'
                        ? { ...step, profileId: task.profile }
                        : step,
                );
            }
            return [...steps];
        },
        signal,
    });

    const result = await pool.run();

    // Defense-in-depth: check pool result against tracker state
    const totalTasks = tracker.taskTracker.getAllTasks().length;
    const settledTasks = result.completedTasks + result.failedTasks;
    if (settledTasks !== totalTasks) {
        console.warn(
            `[implementationPhase] Pool result discrepancy: ${settledTasks} settled tasks (${result.completedTasks} completed + ${result.failedTasks} failed) vs ${totalTasks} total tasks in tracker`,
        );
    }

}
