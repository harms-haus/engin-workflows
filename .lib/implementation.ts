import type { RendererRegistry, StatusCallbacks, StepDefinition, WorkflowRunOptions, WorkflowStatusTracker } from "@harms-haus/engin-engine";
import { LanePool, assignSequentialTaskIds, clearTaskSessions, createHookRegistry } from "@harms-haus/engin-engine";
import type { Plan } from "./schemas";
import { CODE_STEPS, NON_CODE_STEPS } from "./steps";
import { join } from "node:path";

// ─── Step resolution helper ───────────────────────────────────────────────

/**
 * Synchronous step resolver shared by BOTH the `getStepsForTask` option (used
 * at registration time to populate `onTaskRegister` step definitions for the
 * TUI/web AgentLog + step-progress) and the `beforeTask` hook (used at claim
 * time to decide which steps a lane actually runs). Keeping both in sync via a
 * single source of truth avoids the divergence where `onTaskRegister` fires
 * with an empty step list.
 */
function resolveImplementationSteps(task: { isCode?: boolean; profile?: string }): StepDefinition[] {
    const baseSteps: readonly StepDefinition[] =
        task.isCode !== false ? CODE_STEPS : NON_CODE_STEPS;
    let steps: StepDefinition[] = [...baseSteps];
    if (task.profile && task.profile !== 'implementer') {
        steps = steps.map(step =>
            step.profileId === 'implementer'
                ? { ...step, profileId: task.profile }
                : step,
        );
    }
    return steps;
}

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the tracker
 * 2. Claiming and dispatching tasks to implementers
 * 3. Reviewing completed tasks
 * 4. Accepting or rejecting based on review
 *
 * Step resolution is provided via TWO seams that share a single helper
 * (`resolveImplementationSteps`):
 *   1. `getStepsForTask` — synchronous, invoked at registration time so the
 *      engine fires `onTaskRegister` with the correct step definitions for
 *      the TUI/web AgentLog + step-progress.
 *   2. `beforeTask` hook — async, invoked at claim time in
 *      `LanePool.resolveRunner`. This lets a workflow that supplies its OWN
 *      `beforeTask` subscriber run ALONGSIDE this one (first-wins: the first
 *      non-`undefined` result decides).
 * Both are seeded from the same helper so they always agree.
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
    hookRegistry?: WorkflowRunOptions["hookRegistry"],
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

    // 2. Resolve the hook registry. spir.ts forwards the engine-assembled (or
    // freshly created) registry so the engine's default auditor + prompt hooks
    // fire for this phase's lane pool. Direct callers that omit it get a fresh
    // local registry so the `beforeTask` step-substitution hook below still has
    // a home — without it the pool would have no step source.
    const resolvedRegistry = hookRegistry ?? createHookRegistry();

    // 3. Register the `beforeTask` step-substitution hook. This fires at
    // claim time in `LanePool.resolveRunner` (first-wins). A workflow-provided
    // `beforeTask` subscriber registered BEFORE this one wins; one registered
    // AFTER is short-circuited.
    resolvedRegistry.register({
        beforeTask: ({ task }) => {
            return { steps: resolveImplementationSteps(task) };
        },
    });

    // 4. Create and run the lane pool
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
        // Synchronous step seed: drives `onTaskRegister` step definitions so
        // the TUI/web AgentLog + step-progress render correctly. The `beforeTask`
        // hook (also wired via `resolvedRegistry`) fires at claim time and
        // returns the same steps — both share `resolveImplementationSteps`.
        getStepsForTask: resolveImplementationSteps,
        // Thread the resolved hook registry so `LanePool.resolveRunner` fires
        // the `beforeTask` hook registered above (step substitution) AND so
        // the engine's default auditor / prompt hooks fire for this pool.
        hookRegistry: resolvedRegistry,
        // A failed task is reset and re-run from step 1 (sessions cleared) up to
        // 2 extra times — 3 total attempts — before it is left failed.
        maxTaskRetries: 2,
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
