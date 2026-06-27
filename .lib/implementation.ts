import type {
  RendererRegistry,
  Runner,
  SessionSpec,
  StatusCallbacks,
  WorkflowRunOptions,
  WorkflowStatusTracker,
} from "@harms-haus/engin-engine";
import {
  RunnerPool,
  assignSequentialTaskIds,
  createHookRegistry,
  linearRunner,
  reviewRunner,
  singleSession,
} from "@harms-haus/engin-engine";
import type { Plan } from "./schemas";
import { ReviewResultSchema } from "./schemas";
import { join } from "node:path";

// ─── Runner-tree resolution ───────────────────────────────────────────────

/**
 * A session-spec shaped value passed to the runner factories
 * (`singleSession`, `reviewRunner`). It is a {@link SessionSpec} minus the
 * deterministic `id` (assigned at run time from the task id) plus a `role`
 * label that drives session-id derivation and status callbacks.
 */
type SessionRoleSpec = Omit<SessionSpec, "id"> & { role: string };

/**
 * Prompt used by the implement-reviewer session. The reviewer evaluates the
 * implementation against the task prompt and returns a structured
 * {@link ReviewResultSchema} verdict.
 */
const REVIEW_PROMPT = [
  "Review the implementation for this task.",
  "Check correctness, completeness, and adherence to the task prompt.",
  "Respond with a structured review: approved flag, feedback, and any issues",
  "(file, description, severity).",
].join(" ");

/**
 * Resolve the implementation task shape consumed by the runner factories.
 *
 * `profile` defaults to `'implementer'`; a task that carries a different
 * profile id substitutes it for the implementer session while the test-writer
 * and implement-reviewer profiles are preserved.
 */
function resolveImplProfile(task: { profile?: string }): string {
  return task.profile && task.profile !== "implementer"
    ? task.profile
    : "implementer";
}

/**
 * Build the runner tree for a single implementation task.
 *
 * The tree mirrors the old step pipeline (`CODE_STEPS` / `NON_CODE_STEPS`) but
 * expressed as composed runners instead of {@link StepDefinition}s:
 *
 *   • Code tasks →
 *       linearRunner([
 *         singleSession(write-tests),
 *         reviewRunner(execute, review),
 *       ])
 *   • Non-code tasks →
 *       reviewRunner(
 *         execute = singleSession(execute),
 *         review  = singleSession(review),
 *       )
 *
 * `reviewRunner` drives the execute→review loop (approve / reject + feedback,
 * up to `DEFAULT_MAX_ROUNDS` rounds). The test-writer session only runs for
 * code tasks, ahead of the implement→review loop, via `linearRunner`.
 */
function resolveImplementationRunner(task: {
  isCode?: boolean;
  profile?: string;
  prompt: string;
}): Runner {
  const isCode = task.isCode !== false;
  const implProfile = resolveImplProfile(task);

  const testSpec: SessionRoleSpec = {
    role: "write-tests",
    runnerRole: "write-tests",
    profile: "test-writer",
    prompt: task.prompt,
    outputMode: "text",
    isReadOnly: false,
    attempt: 1,
  };
  const implSpec: SessionRoleSpec = {
    role: "execute",
    runnerRole: "execute",
    profile: implProfile,
    prompt: task.prompt,
    outputMode: "text",
    isReadOnly: false,
    attempt: 1,
  };
  const reviewSpec: SessionRoleSpec = {
    role: "review",
    runnerRole: "review",
    profile: "implement-reviewer",
    prompt: REVIEW_PROMPT,
    schema: ReviewResultSchema,
    outputMode: "structured",
    isReadOnly: true,
    attempt: 1,
  };

  if (isCode) {
    // Test-first: write tests, then run the implement→review loop,
    // composed as a linear pipeline (test-writer runs, then the
    // reviewRunner drives execute↔review).
    const testRunner = singleSession(testSpec);
    const reviewLoop = reviewRunner(implSpec, reviewSpec);

    return linearRunner([testRunner, reviewLoop]);
  }

  return reviewRunner(implSpec, reviewSpec);
}

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the tracker
 * 2. Dispatching tasks to a {@link RunnerPool} where each task runs its
 *    resolved runner tree (test → implement → review)
 *
 * Runner resolution is provided via TWO seams that share a single helper
 * (`resolveImplementationRunner`):
 *   1. `getRunnerForTask` — the {@link RunnerPool} option that returns the
 *      runner tree for a task.
 *   2. `beforeTask` hook — invoked at claim time; returns `{ runner }` so a
 *      workflow that supplies its OWN `beforeTask` subscriber can override the
 *      runner (first-wins: the first non-`undefined` result decides).
 *
 * Resume: the explicit session-wipe for non-complete tasks was removed. Replay
 * idempotency (`runSession` skips cached sessions) handles resume, and the
 * pool's internal retry valve (`clearTaskSessions` in `maybeRetry`) handles
 * retry-wipes. The workflow no longer touches persisted sessions on resume.
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
  worktreeManager?: WorkflowRunOptions["worktreeManager"],
  modelConcurrency: Record<string, number> = {},
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
        phaseId: "implementing",
      });
    }
  }

  // Validate that all dependency references are valid
  tracker.taskTracker.validateAllDependencies();

  // NOTE: no explicit session-wipe on resume. Replay idempotency (runSession
  // skips cached sessions) handles resumed tasks; the pool's retry valve
  // clears sessions for retried tasks. See resolveImplementationRunner doc.

  const sessionBaseDir = join(workDir, "sessions");

  // 2. Resolve the hook registry. spir.ts forwards the engine-assembled (or
  // freshly created) registry so the engine's default auditor + prompt hooks
  // fire for this phase's runner pool. Direct callers that omit it get a
  // fresh local registry so the `beforeTask` runner-substitution hook below
  // still has a home.
  const resolvedRegistry = hookRegistry ?? createHookRegistry();

  // 3. Register the `beforeTask` runner-substitution hook. This fires at
  // claim time (first-wins). A workflow-provided `beforeTask` subscriber
  // registered BEFORE this one wins; one registered AFTER is short-circuited.
  //
  // Cast: the engine's `BeforeTaskResult` type doesn't yet include a `runner`
  // field (transitional gap — the runner-pool handles it at runtime by casting
  // the hook result to `Record<string, unknown>` and checking `result.runner`).
  resolvedRegistry.register({
    beforeTask: ({
      task,
    }: {
      task: Parameters<typeof resolveImplementationRunner>[0];
    }) => ({
      runner: resolveImplementationRunner(task),
    }),
  } as never);

  // 4. Create and run the runner pool
  const pool = new RunnerPool({
    maxConcurrentSessions: maxConcurrentTasks,
    modelConcurrency,
    profilesDirs,
    phaseId: "implementing",
    sessionBaseDir,
    cwd,
    apiKeys,
    onStatus,
    auditLog: tracker.auditLog,
    taskTracker: tracker.taskTracker,
    rendererRegistry,
    // Runner tree source: returns the composed runner (test → implement →
    // review) for each task. Replaces the old getStepsForTask seam.
    getRunnerForTask: resolveImplementationRunner,
    // Thread the resolved hook registry so the pool fires the `beforeTask`
    // hook registered above (runner substitution) AND so the engine's
    // default auditor / prompt hooks fire for this pool.
    hookRegistry: resolvedRegistry,
    // Thread the worktree manager (if supplied by the workflow run) so each
    // task runner can operate in its own isolated worktree.
    worktreeManager,
    // A failed task is reset and re-run (sessions cleared by the pool) up
    // to 2 extra times — 3 total attempts — before it is left failed.
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
