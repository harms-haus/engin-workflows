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
  TaskModeSchema,
  TestsReadySchema,
} from "./schemas";
import type { TaskMode } from "./schemas";
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
 * RED-TEAM directive appended to the write-tests session prompt for
 * `tests_and_code` tasks. The test-writer is the red team of TDD: it writes
 * tests encoding the TARGET behavior that SHOULD FAIL against the current
 * code. Those failures are the spec handed to the green-team (write-code).
 * Failing tests are the express goal — not a bug.
 */
const RED_TEAM_DIRECTIVE = [
  "",
  "## You are the RED team (TDD)",
  "This task has a production-code phase that runs AFTER you. Write tests that encode the TARGET/desired behavior — NOT the current behavior. Those tests SHOULD FAIL against the code as it stands today. Failing tests are your success criterion: they are the specification the green-team (the implementer) will satisfy. Do NOT weaken or skip assertions to make tests pass; do NOT stub out the behavior under test. If every test already passes, your tests are not driving any change — strengthen them so they fail until the intended behavior exists.",
].join("\n");

/**
 * CHARACTERIZATION directive appended to the write-tests session prompt for
 * `just_tests` tasks. Here there is no production-code phase: the goal is to
 * improve/strengthen the test suite against EXISTING code, so the tests must
 * PASS (pin real current behavior, add edge cases, rewrite tautological
 * tests).
 */
const CHARACTERIZATION_DIRECTIVE = [
  "",
  "## Tests on EXISTING code (no production changes will follow)",
  "This task only touches tests — no production code will be changed afterwards. Write tests that PASS against the current code: pin its real observable behavior, add meaningful edge/boundary/invalid-input cases, and rewrite or remove tautological/useless tests. Run the tests and confirm they pass before finishing. (If a test genuinely exposes a real bug, note it in your report — do not leave a failing test behind, since nothing will fix it.)",
].join("\n");

/**
 * GREEN-TEAM directive appended to the write-code session prompt for
 * `tests_and_code` tasks. The implementer must make the red-team's failing
 * tests pass without weakening them.
 */
const GREEN_TEAM_DIRECTIVE = [
  "",
  "## You are the GREEN team (TDD)",
  "The RED team (test-writer) has already written tests encoding the required behavior — they are currently FAILING by design. Implement the production code so those tests PASS. Do NOT modify, delete, weaken, or skip the tests to make them pass. If a test is genuinely wrong, note it in your report rather than editing it. Run the tests to confirm they now pass before finishing.",
].join("\n");

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

/** Default mode assumed when a task carries no `mode` (defensive — the
 *  planner always sets one). Defaults to full TDD red→green, matching the
 *  prior `is_code: true` default behavior. */
export const DEFAULT_TASK_MODE: TaskMode = "tests_and_code";

/** Normalize a planner-provided mode value to a valid {@link TaskMode},
 *  falling back to {@link DEFAULT_TASK_MODE} on anything invalid/missing. */
export function normalizeTaskMode(value: unknown): TaskMode {
  const parsed = TaskModeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_TASK_MODE;
}

/**
 * Build the runner factory for a single implementation task.
 *
 * The runner tree is composed from {@link reviewRunner} and {@link linearRunner}
 * factories (each a {@link SessionPlanFactory}). For `linearRunner`, which
 * expects `SessionPlanRunner[]`, the factories are invoked (`()`) to obtain
 * concrete runner instances. The tree is selected by the task's `mode`:
 *
 *   • `tests_and_code` — TDD red→green, two independent review loops:
 *
 *       linearRunner([
 *         reviewRunner(write-tests, review-tests)(),   // RED team: test-writer → test-reviewer
 *         reviewRunner(write-code,  review-code)(),     // GREEN team: implementer → implement-reviewer
 *       ])
 *
 *     The red-team test-writer writes FAILING tests encoding the target
 *     behavior; the test-reviewer reviews them (failing tests are the goal,
 *     NOT grounds for rejection). Then the green-team implementer makes them
 *     pass; the implement-reviewer reviews the code.
 *
 *   • `just_tests` — improve the test suite on EXISTING code only (no
 *     production-code phase). The test-writer writes tests that PASS against
 *     current code:
 *
 *       reviewRunner(write-tests, review-tests)
 *
 *   • `code_only` — production code with NO separate test-writing phase
 *     (mechanical fixes / changes already covered by tests):
 *
 *       reviewRunner(write-code, review-code)
 *
 *   • `no_code_execution` — docs / config / comments, no test phase:
 *
 *       reviewRunner(execute, review)
 *
 * The execute sessions (write-tests / write-code / execute) run in
 * structured-output mode against a done-signal schema (`TestsReadySchema` /
 * `ImplementationDoneSchema`) so an agent that stops before finishing its work
 * is re-prompted in-session by the engine's `promptForStructured` instead of
 * silently producing an empty result.
 *
 * `mode` is the planner-derived task mode. It is deliberately passed in
 * explicitly rather than read off the engine `Task` — `mode` is a workflow
 * concern unrelated to worktree creation (every implementation task gets a
 * worktree regardless).
 */
function resolveImplementationRunner(
  task: { profile?: string; prompt: string },
  mode: TaskMode,
): SessionPlanFactory {
  const implProfile = resolveImplProfile(task);

  // ── Shared spec builders ──────────────────────────────────────────────
  // `write-code` runs the implementer in structured-output mode with an
  // `implementation_done` done-signal (catches early exit at the source via
  // in-session re-prompts). The optional `greenTeam` flag appends the
  // GREEN_TEAM_DIRECTIVE so the implementer knows it must satisfy the
  // red-team's failing tests without weakening them.
  const buildCodeImplSpec = (opts: {
    greenTeam?: boolean;
  }): ReviewSessionSpec => ({
    role: "write-code",
    profile: implProfile,
    prompt:
      task.prompt +
      (opts.greenTeam ? GREEN_TEAM_DIRECTIVE : "") +
      IMPLEMENTATION_DONE_SIGNAL,
    schema: ImplementationDoneSchema,
    outputMode: "structured",
    isReadOnly: false,
  });

  const codeReviewSpec: ReviewSessionSpec = {
    role: "review-code",
    profile: "implement-reviewer",
    prompt: REVIEW_PROMPT,
    schema: ReviewResultSchema,
    outputMode: "structured",
    isReadOnly: true,
  };

  // `write-tests` runs the test-writer in structured-output mode with a
  // `tests_ready` done-signal. `directive` selects the red-team (failing
  // tests) vs characterization (passing tests) framing for the mode.
  const buildWriteTestsSpec = (directive: string): ReviewSessionSpec => ({
    role: "write-tests",
    profile: "test-writer",
    prompt: `${task.prompt}${directive}${TESTS_READY_SIGNAL}`,
    schema: TestsReadySchema,
    outputMode: "structured",
    isReadOnly: false,
  });

  const reviewTestsSpec: ReviewSessionSpec = {
    role: "review-tests",
    profile: "test-reviewer",
    prompt: REVIEW_TESTS_PROMPT,
    schema: ReviewResultSchema,
    outputMode: "structured",
    isReadOnly: true,
  };

  switch (mode) {
    case "tests_and_code": {
      // RED team (failing tests) → GREEN team (make them pass), composed linearly.
      const testLoop = reviewRunner(
        buildWriteTestsSpec(RED_TEAM_DIRECTIVE),
        reviewTestsSpec,
      )();
      const codeLoop = reviewRunner(
        buildCodeImplSpec({ greenTeam: true }),
        codeReviewSpec,
      )();
      return linearRunner([testLoop, codeLoop]);
    }

    case "just_tests": {
      // Improve tests on EXISTING code — tests should PASS (characterization).
      return reviewRunner(
        buildWriteTestsSpec(CHARACTERIZATION_DIRECTIVE),
        reviewTestsSpec,
      );
    }

    case "code_only": {
      // Production code with no separate test-writing phase.
      return reviewRunner(buildCodeImplSpec({}), codeReviewSpec);
    }

    case "no_code_execution":
    default: {
      // Generic execute → review loop (docs / config / comments).
      const executeSpec: ReviewSessionSpec = {
        ...buildCodeImplSpec({}),
        role: "execute",
      };
      const reviewSpec: ReviewSessionSpec = {
        ...codeReviewSpec,
        role: "review",
      };
      return reviewRunner(executeSpec, reviewSpec);
    }
  }
}

/**
 * Resolve the declared session-plan entries for a task — the ordered list of
 * sessions the runner tree will produce. Used by the `beforeTask` hook so
 * observers can render planned sessions + a progress counter.
 */
function resolveSessionPlan(
  task: { profile?: string },
  mode: TaskMode,
): SessionPlanEntry[] {
  const implProfile = resolveImplProfile(task);
  switch (mode) {
    case "tests_and_code":
      return [
        { role: "write-tests", profile: "test-writer" },
        { role: "review-tests", profile: "test-reviewer" },
        { role: "write-code", profile: implProfile },
        { role: "review-code", profile: "implement-reviewer" },
      ];
    case "just_tests":
      return [
        { role: "write-tests", profile: "test-writer" },
        { role: "review-tests", profile: "test-reviewer" },
      ];
    case "code_only":
      return [
        { role: "write-code", profile: implProfile },
        { role: "review-code", profile: "implement-reviewer" },
      ];
    case "no_code_execution":
    default:
      return [
        { role: "execute", profile: implProfile },
        { role: "review", profile: "implement-reviewer" },
      ];
  }
}

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the shared {@link TaskGraph} (each with its resolved
 *    runner factory).
 * 2. Dispatching the graph through a {@link SessionScheduler} where each task
 *    runs its resolved runner tree (selected by the task's `mode`).
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
  // `mode` is a planner/workflow signal that controls which runner tree is
  // built (tests_and_code / just_tests / code_only / no_code_execution). It
  // is NOT threaded onto the engine Task — it is unrelated to worktree
  // creation. It is carried in a sidecar map so runner resolution can read
  // it without polluting the engine Task shape. ALL implementation tasks get
  // a worktree (`worktree: 'code'`) regardless of mode.
  const renumberedTasks = assignSequentialTaskIds(plan.tasks);
  const taskMode = new Map<string, TaskMode>();
  for (const task of renumberedTasks) {
    const mode = normalizeTaskMode(task.mode);
    taskMode.set(task.id, mode);
    if (!taskGraph.getTask(task.id)) {
      const runnerFactory = resolveImplementationRunner(task, mode);
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
  // `mode` is read from the sidecar map (keyed by task id). Falls back to
  // {@link DEFAULT_TASK_MODE} (tests_and_code) when the task id isn't in the
  // sidecar (defensive — the map is populated for every plan task above).
  resolvedRegistry.register({
    beforeTask: ({
      task,
    }: {
      task: { id: string; profile?: string; prompt: string };
    }) => {
      const mode = taskMode.get(task.id) ?? DEFAULT_TASK_MODE;
      const runner = resolveImplementationRunner(task, mode);
      const sessionPlan = resolveSessionPlan(task, mode);
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
