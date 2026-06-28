import type {
  AgentProfile,
  AuditLog,
  RendererRegistry,
  SessionPlanFactory,
  SessionSpec,
  StatusCallbacks,
  TaskGraph,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  AuditLog as AuditLogCtor,
  SessionGate,
  SessionScheduler,
  assignSequentialTaskIds,
  createHookRegistry,
  linearRunner,
  loadProfilesFromDirs,
  reviewRunner,
} from "@harms-haus/engin-engine";
import type { Plan } from "./schemas";
import {
  ImplementationDoneSchema,
  ReviewResultSchema,
  TestsReadySchema,
} from "./schemas";
import { join } from "node:path";

// ─── Runner-tree resolution ───────────────────────────────────────────────

/**
 * Spec for a session consumed by {@link reviewRunner}. Mirrors the
 * `Omit<SessionSpec, 'id' | 'attempt' | 'runnerRole'> & { role: string }`
 * shape — `runnerRole` is derived from `role` internally.
 */
type ReviewSessionSpec = Omit<SessionSpec, "id" | "attempt" | "runnerRole"> & {
  role: string;
};

/** One entry in a task's declared session plan — the ordered list of sessions
 *  a task's runner tree will produce (e.g. write-tests → execute → review).
 *  Declared upfront so a TUI / observer can show all planned sessions and a
 *  progress counter. */
interface SessionPlanEntry {
  role: string;
  profile: string;
}

/**
 * Prompt used by the test-reviewer (review-tests) session. The reviewer
 * evaluates the tests written for the task against the task prompt and returns
 * a structured {@link ReviewResultSchema} verdict.
 */
const REVIEW_TESTS_PROMPT = [
  "Review the tests written for this task.",
  "Read the test files and check they cover the task's requirements accurately",
  "and follow sound testing practices.",
  "Respond with a structured review: approved flag, feedback, and any issues",
  "(file, description, severity).",
].join(" ");

/**
 * Prompt used by the implement-reviewer (review-code) session. The reviewer
 * evaluates the implementation against the task prompt and returns a structured
 * {@link ReviewResultSchema} verdict.
 */
const REVIEW_PROMPT = [
  "Review the implementation for this task.",
  "Check correctness, completeness, and adherence to the task prompt.",
  "Respond with a structured review: approved flag, feedback, and any issues",
  "(file, description, severity).",
].join(" ");

/**
 * Completion-signal instruction appended to the test-writer (write-tests)
 * session prompt. The session runs in structured-output mode against
 * {@link TestsReadySchema}; this instruction ties the signal to the work so the
 * agent self-certifies only after the tests are written.
 */
const TESTS_READY_SIGNAL = [
  "",
  "## Completion signal (required)",
  'After you have written the tests, respond with ONLY this JSON object: { "tests_ready": true }.',
  'Respond with { "tests_ready": false } only if you genuinely cannot write the tests.',
  "Do not send the signal until the tests are written — it is how the workflow knows you finished.",
].join("\n");

/**
 * Completion-signal instruction appended to the implementer (execute) session
 * prompt. The session runs in structured-output mode against
 * {@link ImplementationDoneSchema}; this instruction ties the signal to the
 * work so the agent self-certifies only after the task is fully implemented.
 */
const IMPLEMENTATION_DONE_SIGNAL = [
  "",
  "## Completion signal (required)",
  'After you have fully implemented the task, respond with ONLY this JSON object: { "implementation_done": true }.',
  'Respond with { "implementation_done": false } only if you genuinely cannot complete the task.',
  "Do not send the signal until the implementation is complete — it is how the workflow knows you finished.",
].join("\n");

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
 * Build the runner factory for a single implementation task.
 *
 * The runner tree is composed from {@link reviewRunner} and {@link linearRunner}
 * factories (each a {@link SessionPlanFactory}). For `linearRunner`, which
 * expects `SessionPlanRunner[]`, the factories are invoked (`()`) to obtain
 * concrete runner instances.
 *
 *   • Code tasks (`is_code: true`) — test-first, two independent review loops:
 *
 *       linearRunner([
 *         reviewRunner(write-tests, review-tests)(),   // test-writer → test-reviewer
 *         reviewRunner(write-code, review-code)(),     // implementer → implement-reviewer
 *       ])
 *
 *     The test loop runs first: the test-writer writes tests, the test-reviewer
 *     reviews them. Then the code loop runs: the implementer writes code, the
 *     implement-reviewer reviews it. Each `reviewRunner` drives its own
 *     execute→review loop (approve / reject + feedback, up to
 *     `DEFAULT_MAX_ROUNDS` rounds).
 *
 *   • Non-code tasks — a single review loop:
 *
 *       reviewRunner(execute, review)                  // implementer → implement-reviewer
 *
 * The execute sessions (write-tests / write-code / execute) run in
 * structured-output mode against a done-signal schema (`TestsReadySchema` /
 * `ImplementationDoneSchema`) so an agent that stops before finishing its work
 * is re-prompted in-session by the engine's `promptForStructured` instead of
 * silently producing an empty result.
 *
 * `isCode` is the planner-derived `is_code` signal. It is deliberately passed
 * in explicitly rather than read off the engine `Task` — `is_code` is a
 * workflow concern unrelated to worktree creation (every implementation task
 * gets a worktree regardless).
 */
function resolveImplementationRunner(
  task: { profile?: string; prompt: string },
  isCode: boolean,
): SessionPlanFactory {
  const implProfile = resolveImplProfile(task);

  // Code-task sessions use distinct role labels (write-tests / review-tests /
  // write-code / review-code) so their session directories and projections are
  // unambiguous. Non-code tasks keep the generic execute / review roles.
  const codeImplSpec: ReviewSessionSpec = {
    role: "write-code",
    profile: implProfile,
    prompt: `${task.prompt}${IMPLEMENTATION_DONE_SIGNAL}`,
    // Structured output with an `implementation_done` done-signal — catches
    // early exit at the source via in-session re-prompts.
    schema: ImplementationDoneSchema,
    outputMode: "structured",
    isReadOnly: false,
  };
  const codeReviewSpec: ReviewSessionSpec = {
    role: "review-code",
    profile: "implement-reviewer",
    prompt: REVIEW_PROMPT,
    schema: ReviewResultSchema,
    outputMode: "structured",
    isReadOnly: true,
  };

  if (isCode) {
    const writeTestsSpec: ReviewSessionSpec = {
      role: "write-tests",
      profile: "test-writer",
      prompt: `${task.prompt}${TESTS_READY_SIGNAL}`,
      // Structured output with a `tests_ready` done-signal — same early-exit
      // protection as the implementer session.
      schema: TestsReadySchema,
      outputMode: "structured",
      isReadOnly: false,
    };
    const reviewTestsSpec: ReviewSessionSpec = {
      role: "review-tests",
      profile: "test-reviewer",
      prompt: REVIEW_TESTS_PROMPT,
      schema: ReviewResultSchema,
      outputMode: "structured",
      isReadOnly: true,
    };

    // Test-first pipeline: test loop, then code loop, composed linearly.
    return linearRunner([
      reviewRunner(writeTestsSpec, reviewTestsSpec)(),
      reviewRunner(codeImplSpec, codeReviewSpec)(),
    ]);
  }

  // Non-code: generic execute → review loop.
  const executeSpec: ReviewSessionSpec = {
    ...codeImplSpec,
    role: "execute",
  };
  const reviewSpec: ReviewSessionSpec = {
    ...codeReviewSpec,
    role: "review",
  };
  return reviewRunner(executeSpec, reviewSpec);
}

/**
 * Resolve the declared session-plan entries for a task — the ordered list of
 * sessions the runner tree will produce. Used by the `beforeTask` hook so
 * observers can render planned sessions + a progress counter.
 */
function resolveSessionPlan(
  task: { profile?: string },
  isCode: boolean,
): SessionPlanEntry[] {
  const implProfile = resolveImplProfile(task);
  if (isCode) {
    return [
      { role: "write-tests", profile: "test-writer" },
      { role: "review-tests", profile: "test-reviewer" },
      { role: "write-code", profile: implProfile },
      { role: "review-code", profile: "implement-reviewer" },
    ];
  }
  return [
    { role: "execute", profile: implProfile },
    { role: "review", profile: "implement-reviewer" },
  ];
}

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the shared {@link TaskGraph} (each with its resolved
 *    runner factory).
 * 2. Dispatching the graph through a {@link SessionScheduler} where each task
 *    runs its resolved runner tree (test → implement → review).
 *
 * Runner resolution is provided via TWO seams that share a single helper
 * (`resolveImplementationRunner`):
 *   1. `taskGraph.addTask(task, runnerFactory)` — the primary runner source;
 *      the scheduler instantiates the runner from the factory at claim time.
 *   2. `beforeTask` hook — invoked at claim time; returns
 *      `{ runner: SessionPlanFactory, sessionPlan }` so a workflow that
 *      supplies its OWN `beforeTask` subscriber can override the runner
 *      (first-wins: the first non-`undefined` result decides).
 *
 * Resume: the explicit session-wipe for non-complete tasks was removed. Replay
 * idempotency (`runSession` skips cached sessions) handles resume, and the
 * scheduler's internal retry handling clears sessions for retried tasks. The
 * workflow no longer touches persisted sessions on resume.
 */
export async function implementationPhase(
  taskGraph: TaskGraph,
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
  // 1. Load plan tasks into the shared task graph (renumber IDs to sequential
  //    t-0N form). Each task gets its resolved runner factory.
  //
  // `is_code` is a planner/workflow signal that controls runner flow
  // (test-first vs execute→review). It is NOT threaded onto the engine Task —
  // it is unrelated to worktree creation. It is carried in a sidecar map so
  // runner resolution can read it without polluting the engine Task shape.
  // ALL implementation tasks get a worktree (`worktree: 'code'`) regardless
  // of whether they touch code, docs, or config.
  const renumberedTasks = assignSequentialTaskIds(plan.tasks);
  const taskIsCode = new Map<string, boolean>();
  for (const task of renumberedTasks) {
    taskIsCode.set(task.id, task.is_code);
    if (!taskGraph.getTask(task.id)) {
      const runnerFactory = resolveImplementationRunner(
        task,
        task.is_code,
      );
      taskGraph.addTask(
        {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          profile: task.profile,
          files: task.files,
          dependencies: task.dependencies,
          worktree: "code",
          phaseId: "implementing",
          status: "ready",
        },
        runnerFactory,
      );
    }
  }

  // Validate dependencies: TaskGraph performs cycle detection at add time
  // (addTask throws on a cycle). Deadlocked tasks (missing deps) are detected
  // and failed by SessionScheduler.run() at startup via failDeadlockedTasks().

  // NOTE: no explicit session-wipe on resume. Replay idempotency (runSession
  // skips cached sessions) handles resumed tasks; the scheduler handles
  // retry-wipes. See resolveImplementationRunner doc.

  // 2. Resolve the hook registry. spir.ts forwards the engine-assembled (or
  // freshly created) registry so the engine's default auditor + prompt hooks
  // fire for this phase's scheduler. Direct callers that omit it get a fresh
  // local registry so the `beforeTask` runner-substitution hook below still
  // has a home.
  const resolvedRegistry = hookRegistry ?? createHookRegistry();

  // 3. Register the `beforeTask` runner-substitution hook. This fires at
  // claim time (first-wins). A workflow-provided `beforeTask` subscriber
  // registered BEFORE this one wins; one registered AFTER is short-circuited.
  //
  // The hook returns `{ runner: SessionPlanFactory, sessionPlan }`. The
  // scheduler checks `typeof result.runner === 'object'` — a factory is a
  // function, so the scheduler falls through to the task's runnerFactory
  // (registered via addTask, which is the same factory). The hook exists so
  // external beforeTask subscribers can override the runner, and so the
  // declared sessionPlan is available for observer consumers.
  //
  // `is_code` is read from the sidecar map (keyed by task id). Falls back to
  // test-first (is_code=true) when the task id isn't in the sidecar
  // (defensive — the map is populated for every plan task above).
  resolvedRegistry.register({
    beforeTask: ({
      task,
    }: {
      task: { id: string; profile?: string; prompt: string };
    }) => {
      const isCode = taskIsCode.get(task.id) ?? true;
      const runner = resolveImplementationRunner(task, isCode);
      const sessionPlan = resolveSessionPlan(task, isCode);
      return { runner, sessionPlan };
    },
  } as never);

  // 4. Load profiles + build the session gate, audit log, and active-session
  //    set for the SessionScheduler.
  const profiles: Map<string, AgentProfile> =
    await loadProfilesFromDirs(profilesDirs);
  const gate = new SessionGate({
    total: maxConcurrentTasks,
    perModel: modelConcurrency,
  });
  const auditLog: AuditLog = new AuditLogCtor(workDir);
  const activeSessions = new Set<{ abort(): Promise<void> }>();

  const scheduler = new SessionScheduler({
    graph: taskGraph,
    gate,
    profiles,
    sessionBaseDir: join(workDir, "sessions"),
    cwd,
    onStatus,
    hookRegistry: resolvedRegistry,
    auditLog,
    signal,
    phaseId: "implementing",
    ...(apiKeys !== undefined ? { apiKeys } : {}),
    ...(rendererRegistry !== undefined ? { rendererRegistry } : {}),
    ...(worktreeManager !== undefined ? { worktreeManager } : {}),
    activeSessions,
  });

  const result = await scheduler.run();

  // Defense-in-depth: check scheduler result against graph state
  const totalTasks = taskGraph.getAllTasks().length;
  const settledTasks = result.completedTasks + result.failedTasks;
  if (settledTasks !== totalTasks) {
    console.warn(
      `[implementationPhase] Scheduler result discrepancy: ${settledTasks} settled tasks (${result.completedTasks} completed + ${result.failedTasks} failed) vs ${totalTasks} total tasks in graph`,
    );
  }
}
