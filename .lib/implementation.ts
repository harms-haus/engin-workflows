import type { RendererRegistry, StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin-engine";
import { LanePool, assignSequentialTaskIds, clearTaskSessions } from "@harms-haus/engin-engine";
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
    rendererRegistry?: RendererRegistry,
): Promise<void> {
    // 1. Load plan tasks into the tracker (renumber IDs to sequential t-0N form)
    const renumberedTasks = assignSequentialTaskIds(plan.tasks);
    for (const task of renumberedTasks) {
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

    // 1b. On a resumed run, tasks that didn't complete (failed / interrupted /
    // never-started) must restart from step 1 with a clean slate. Clear their
    // persisted sessions so nothing resumes stale state. Completed tasks keep
    // their sessions. On a fresh run this is a harmless no-op (no sessions yet).
    const sessionBaseDir = join(workDir, 'sessions');
    for (const task of tracker.taskTracker.getAllTasks()) {
        if (task.status !== 'complete') {
            clearTaskSessions(sessionBaseDir, task.id);
        }
    }

    // 2. Create and run the lane pool
    const pool = new LanePool({
        maxConcurrentLanes: maxConcurrentTasks,
        profilesDirs,
        phaseId: 'implementing',
        sessionBaseDir,
        cwd,
        apiKeys,
        onStatus,
        auditLog: tracker.auditLog,
        taskTracker: tracker.taskTracker,
        rendererRegistry,
        // A failed task is reset and re-run from step 1 (sessions cleared) up to
        // 2 extra times — 3 total attempts — before it is left failed.
        maxTaskRetries: 2,
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
