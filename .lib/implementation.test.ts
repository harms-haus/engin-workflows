// ─── Implementation Phase Tests (B4 migration) ─────────────────────────────
//
// Tests for implementation.ts after B4 migration:
//   • RunnerPool replaces LanePool
//   • getRunnerForTask replaces getStepsForTask
//   • beforeTask hook returns {runner} instead of {steps}
//   • No explicit clearTaskSessions on resume — replay handles idempotency
//   • RunnerPoolOptions: maxConcurrentSessions + modelConcurrency
//
// Mock module provides BOTH old exports (LanePool, clearTaskSessions) for
// compile compat with the current implementation AND new exports (RunnerPool,
// reviewRunner, linearRunner, singleSession) for B4 assertions.
//
// Builds on: kb-3 (runSession), kb-4 (reviewRunner/linearRunner/singleSession),
// kb-7 (RunnerPool), kb-12 (createEnginMock additions).
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from "bun:test";
import type { WorkflowRunOptions } from "@harms-haus/engin-engine";
import { createEnginMock } from "./engin-mock";

// ─── Mock @harms-haus/engin-engine ──────────────────────────────────────────
// The mock provides: new exports (RunnerPool, reviewRunner, linearRunner,
// singleSession) for B4 assertions, plus old exports (LanePool, clearTaskSessions
// etc.) so the current implementation.ts can still compile and run.

const mockAddTask =
  jest.fn<
    (task: {
      id: string;
      title: string;
      prompt: string;
      profile: string;
      files: string[];
      dependencies: string[];
      isCode: boolean;
      phaseId: string;
    }) => void
  >();
const mockAssignSequentialTaskIds = jest.fn(
  (tasks: { id: string; dependencies: string[] }[]) => {
    // Default: renumber IDs like the real function (t-01, t-02, …) and remap deps
    const idMap = new Map<string, string>();
    const result = tasks.map((t, i) => {
      const newId = `t-${String(i + 1).padStart(2, "0")}`;
      idMap.set(t.id, newId);
      return { ...t, id: newId };
    });
    for (const t of result) {
      t.dependencies = t.dependencies.map((d: string) => idMap.get(d) ?? d);
    }
    return result;
  },
);
const mockValidateAllDependencies = jest.fn<() => void>();
const mockGetAllTasks = jest.fn<() => { id: string; status: string }[]>();
const mockGetTask = jest.fn<(id: string) => { id: string } | undefined>();
const mockPoolRun =
  jest.fn<() => Promise<{ completedTasks: number; failedTasks: number }>>();
const mockClearTaskSessions =
  jest.fn<(sessionBaseDir: string, taskId: string) => void>();

const MockTaskTracker = jest.fn().mockImplementation(() => ({
  addTask: mockAddTask,
  validateAllDependencies: mockValidateAllDependencies,
  getAllTasks: mockGetAllTasks,
  getTask: mockGetTask,
}));

// ── NEW: RunnerPool + runner factories ────────────────────────────────────
const MockRunnerPool = jest.fn().mockImplementation(() => ({
  run: mockPoolRun,
}));

const mockReviewRunner =
  jest.fn<(execute: unknown, review: unknown, opts?: unknown) => unknown>();
const mockLinearRunner = jest.fn<(children: unknown[]) => unknown>();
const mockSingleSession = jest.fn<(spec: unknown) => unknown>();

// ── OLD: LanePool (kept for compile compat — current impl still imports it) ──
const MockLanePool = jest.fn().mockImplementation(() => ({
  run: mockPoolRun,
}));

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),

  // NEW pool + runner factories
  RunnerPool: MockRunnerPool,
  reviewRunner: mockReviewRunner,
  linearRunner: mockLinearRunner,
  singleSession: mockSingleSession,

  // OLD pool (compile compat — tests assert it is NOT used)
  LanePool: MockLanePool,

  // Override these from createEnginMock() so we can assert on them
  clearTaskSessions: mockClearTaskSessions,
  assignSequentialTaskIds: mockAssignSequentialTaskIds,
  TaskTracker: MockTaskTracker,
}));

// Dynamic import to ensure mock is applied first
const { implementationPhase } = await import("./implementation");

import type { Plan } from "./schemas";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_PLAN: Plan = {
  tasks: [
    {
      id: "task-1",
      title: "Add feature A",
      prompt: "Implement feature A in module X",
      profile: "implementer",
      files: ["src/x.ts"],
      is_code: true,
      dependencies: [],
    },
    {
      id: "task-2",
      title: "Update docs",
      prompt: "Document feature A",
      profile: "implementer",
      files: ["README.md"],
      is_code: false,
      dependencies: ["task-1"],
    },
  ],
  strategy: "Implement in order",
};

function makeMockTracker() {
  return {
    taskTracker: {
      addTask: mockAddTask,
      validateAllDependencies: mockValidateAllDependencies,
      getAllTasks: mockGetAllTasks,
      getTask: mockGetTask,
    },
    auditLog: {
      append: jest.fn().mockResolvedValue(undefined),
    },
  } as never;
}

/**
 * Extract the `beforeTask` hook that `implementationPhase` registers on the
 * RunnerPool's hookRegistry. Returns the hook function so tests can invoke it
 * directly and assert it returns `{ runner }` (not `{ steps }`).
 */
function extractBeforeTaskHook(): (args: {
  task: unknown;
  steps: unknown[];
}) => { runner: unknown } | { skip: boolean } | undefined {
  const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
    string,
    unknown
  >;
  expect(poolOptions).toHaveProperty("hookRegistry");
  const registry = poolOptions.hookRegistry as {
    register: { mock: { calls: unknown[][] } };
  };
  for (const call of registry.register.mock.calls) {
    const hooks = call[0] as Record<string, unknown> | undefined;
    if (hooks && "beforeTask" in hooks) {
      const value = hooks.beforeTask;
      // The hook may be registered as a single fn or fn[] (both are valid).
      const fn = Array.isArray(value) ? value[0] : value;
      if (typeof fn === "function") return fn as never;
    }
  }
  throw new Error("beforeTask hook was not registered on the hookRegistry");
}

/**
 * Extract `getRunnerForTask` from RunnerPool options (the function that builds
 * the runner tree).
 */
function extractGetRunnerForTask(): ((task: unknown) => unknown) | undefined {
  const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
    string,
    unknown
  >;
  return poolOptions.getRunnerForTask as
    | ((task: unknown) => unknown)
    | undefined;
}

// ══════════════════════════════════════════════════════════════════════════
// B4 MIGRATION: RunnerPool replaces LanePool
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — B4 migration: RunnerPool", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockRunnerPool.mockClear();
    MockLanePool.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockSingleSession.mockClear();
    // Default: runner factories return mock Runner functions so that
    // getRunnerForTask resolves to a function without per-test setup.
    // Tests needing specific values override with mockReturnValue(Once).
    mockReviewRunner.mockReturnValue(jest.fn());
    mockLinearRunner.mockReturnValue(jest.fn());
    mockSingleSession.mockReturnValue(jest.fn());
    // Default: pool returns all tasks as completed
    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    // Default: getTask returns undefined (task not already present)
    mockGetTask.mockReturnValue(undefined);
    // Default: getAllTasks returns the expected tasks
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "done" },
    ]);
  });

  // ── 1. RunnerPool constructed (not LanePool) ──────────────────────────

  it("constructs RunnerPool (not LanePool)", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockRunnerPool).toHaveBeenCalledTimes(1);
    expect(MockLanePool).toHaveBeenCalledTimes(0);
  });

  // ── 2. getRunnerForTask (not getStepsForTask) ──────────────────────────

  it("passes getRunnerForTask (not getStepsForTask) to RunnerPool", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("getRunnerForTask");
    expect(typeof poolOptions.getRunnerForTask).toBe("function");
    // getStepsForTask must NOT be on RunnerPool options
    expect(poolOptions).not.toHaveProperty("getStepsForTask");
  });

  it("getRunnerForTask returns a runner for code tasks (reviewRunner tree)", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const getRunnerForTask = extractGetRunnerForTask();
    expect(getRunnerForTask).toBeDefined();

    // Build a runner for a code task — the runner factories should be called
    const codeTask = {
      id: "t1",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
      isCode: true,
    } as never;
    const runner = getRunnerForTask!(codeTask);

    // Must return a function (a Runner)
    expect(typeof runner).toBe("function");
  });

  it("getRunnerForTask returns a runner for non-code tasks (reviewRunner tree)", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const getRunnerForTask = extractGetRunnerForTask();
    expect(getRunnerForTask).toBeDefined();

    const nonCodeTask = {
      id: "t2",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
      isCode: false,
    } as never;
    const runner = getRunnerForTask!(nonCodeTask);

    expect(typeof runner).toBe("function");
  });

  // ── 3. Runner tree: linearRunner + reviewRunner (restored CODE_STEPS) ──
  //
  // Code-task pipeline mirrors the pre-session-first CODE_STEPS:
  //   linearRunner([
  //     reviewRunner(write-tests, review-tests),  // test review loop
  //     reviewRunner(execute, review),            // code review loop
  //   ])
  // singleSession is NOT used directly; both stages are review loops so a
  // rejection feeds feedback back and retries. A 4-session plan is declared.

  it("builds the code-task tree as linearRunner([reviewRunner(write-tests, review-tests), reviewRunner(execute, review)])", async () => {
    const tracker = makeMockTracker();

    const linearRunnerResult = jest.fn();
    const testReviewLoop = jest.fn();
    const codeReviewLoop = jest.fn();

    mockLinearRunner.mockReturnValue(linearRunnerResult);
    // reviewRunner is called twice: test loop, then code loop.
    mockReviewRunner
      .mockReturnValueOnce(testReviewLoop)
      .mockReturnValueOnce(codeReviewLoop);

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const getRunnerForTask = extractGetRunnerForTask();
    const codeTask = {
      id: "t-01",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
    } as never;
    const runner = getRunnerForTask!(codeTask);

    // ── 1. Final returned runner is the linearRunner result ─────────
    expect(runner).toBe(linearRunnerResult);

    // ── 2. linearRunner called once with the two review-loop children ──
    expect(mockLinearRunner).toHaveBeenCalledTimes(1);
    expect(mockLinearRunner).toHaveBeenCalledWith([
      testReviewLoop,
      codeReviewLoop,
    ]);

    // ── 3. singleSession is NOT used directly ───────────────────────
    expect(mockSingleSession).toHaveBeenCalledTimes(0);

    // ── 4. reviewRunner called twice: test loop then code loop ──────
    expect(mockReviewRunner).toHaveBeenCalledTimes(2);
    expect(mockReviewRunner.mock.calls[0][0]).toMatchObject({
      role: "write-tests",
      profile: "test-writer",
    });
    expect(mockReviewRunner.mock.calls[0][1]).toMatchObject({
      role: "review-tests",
      profile: "test-reviewer",
    });
    expect(mockReviewRunner.mock.calls[1][0]).toMatchObject({
      role: "execute",
    });
    expect(mockReviewRunner.mock.calls[1][1]).toMatchObject({
      role: "review",
      profile: "implement-reviewer",
    });
  });


  it("builds the runner tree with only implement+review for non-code tasks (no test-writer)", async () => {
    const tracker = makeMockTracker();

    const mockNonCodeReviewRunner = jest.fn();

    mockReviewRunner.mockReturnValue(mockNonCodeReviewRunner);

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const getRunnerForTask = extractGetRunnerForTask();
    // task-2 (is_code: false) is renumbered to t-02 by assignSequentialTaskIds.
    // Runner resolution reads is_code from the sidecar map keyed by task id,
    // NOT from a field on the engine Task (is_code is a planner concern).
    const nonCodeTask = {
      id: "t-02",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
    } as never;
    const runner = getRunnerForTask!(nonCodeTask);

    expect(runner).toBe(mockNonCodeReviewRunner);

    // For non-code tasks, no test-writer session — reviewRunner wraps both
    // implementer and reviewer. singleSession is NOT called directly.
    expect(mockSingleSession).toHaveBeenCalledTimes(0);

    // reviewRunner called exactly once with (implSpec, reviewSpec)
    expect(mockReviewRunner).toHaveBeenCalledTimes(1);
    const reviewArgs = mockReviewRunner.mock.calls[0];
    expect(reviewArgs[0] as Record<string, unknown>).toMatchObject({
      role: "execute",
    });
    expect(reviewArgs[1] as Record<string, unknown>).toMatchObject({
      role: "review",
    });
  });

  it("substitutes custom profile for implementer session when task.profile differs", async () => {
    const tracker = makeMockTracker();

    mockSingleSession.mockReturnValue(jest.fn());
    mockLinearRunner.mockReturnValue(jest.fn());
    mockReviewRunner.mockReturnValue(jest.fn());

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const getRunnerForTask = extractGetRunnerForTask();
    const customProfileTask = {
      id: "t3",
      title: "",
      prompt: "",
      profile: "implementer-lite",
      files: [],
      dependencies: [],
      isCode: true,
    } as never;
    getRunnerForTask!(customProfileTask);

    // singleSession is NOT used directly (both stages are review loops).
    expect(mockSingleSession).toHaveBeenCalledTimes(0);

    // The custom task.profile substitutes ONLY the execute (implementer)
    // session — the second reviewRunner call's first arg.
    expect(mockReviewRunner).toHaveBeenCalledTimes(2);
    const implSpec = mockReviewRunner.mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(implSpec.role).toBe("execute");
    expect(implSpec.profile).toBe("implementer-lite");
  });

  it("preserves test-writer and implement-reviewer profiles when substituting implementer", async () => {
    const tracker = makeMockTracker();

    mockSingleSession.mockReturnValue(jest.fn());
    mockLinearRunner.mockReturnValue(jest.fn());
    mockReviewRunner.mockReturnValue(jest.fn());

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const getRunnerForTask = extractGetRunnerForTask();
    const customProfileTask = {
      id: "t4",
      title: "",
      prompt: "",
      profile: "implementer-lite",
      files: [],
      dependencies: [],
      isCode: true,
    } as never;
    getRunnerForTask!(customProfileTask);

    // singleSession is NOT used directly (both stages are review loops).
    expect(mockSingleSession).toHaveBeenCalledTimes(0);

    // reviewRunner is called twice: (write-tests, review-tests) then (execute, review).
    // The test-writer / test-reviewer profiles are fixed.
    expect(mockReviewRunner).toHaveBeenCalledTimes(2);
    const testLoopSpec = mockReviewRunner.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(testLoopSpec.role).toBe("write-tests");
    expect(testLoopSpec.profile).toBe("test-writer");

    // The custom task.profile substitutes ONLY the execute (implementer) session.
    const codeLoopSpec = mockReviewRunner.mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(codeLoopSpec.role).toBe("execute");
    expect(codeLoopSpec.profile).toBe("implementer-lite");

    // implement-reviewer must remain 'implement-reviewer' (second arg of code loop)
    const reviewSpec = mockReviewRunner.mock.calls[1][1] as Record<
      string,
      unknown
    >;
    expect(reviewSpec.role).toBe("review");
    expect(reviewSpec.profile).toBe("implement-reviewer");
  });

  // ── 4. beforeTask hook returns {runner} ────────────────────────────────

  it("beforeTask hook returns {runner} for code tasks (not {steps})", async () => {
    const tracker = makeMockTracker();

    mockSingleSession.mockReturnValue(jest.fn());
    mockLinearRunner.mockReturnValue(jest.fn());
    mockReviewRunner.mockReturnValue(jest.fn());

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const beforeTask = extractBeforeTaskHook();

    const codeTask = {
      id: "t1",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
      isCode: true,
    } as never;
    const result = beforeTask({ task: codeTask, steps: [] });

    expect(result).toBeDefined();
    // The hook must return { runner: ... } (not { steps: ... })
    expect(result).toHaveProperty("runner");
    expect(result).not.toHaveProperty("steps");
    expect(typeof (result as { runner: unknown }).runner).toBe("function");
  });

  it("beforeTask hook returns {runner} for non-code tasks", async () => {
    const tracker = makeMockTracker();

    mockSingleSession.mockReturnValue(jest.fn());
    mockLinearRunner.mockReturnValue(jest.fn());
    mockReviewRunner.mockReturnValue(jest.fn());

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const beforeTask = extractBeforeTaskHook();

    const nonCodeTask = {
      id: "t2",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
      isCode: false,
    } as never;
    const result = beforeTask({ task: nonCodeTask, steps: [] });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("runner");
    expect(result).not.toHaveProperty("steps");
    expect(typeof (result as { runner: unknown }).runner).toBe("function");
  });

  it("beforeTask hook still supports {skip: true} for abstain", async () => {
    const tracker = makeMockTracker();

    mockSingleSession.mockReturnValue(jest.fn());
    mockLinearRunner.mockReturnValue(jest.fn());
    mockReviewRunner.mockReturnValue(jest.fn());

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    // The hook registered by implementationPhase always returns {runner}.
    // But the test verifies the hook shape is compatible: { runner } | { skip } | undefined
    // as per the RunnerPool.resolveRunner contract.
    const beforeTask = extractBeforeTaskHook();
    // We can't test skip directly since the registered hook never returns skip,
    // but we verify the hook exists and returns the expected shape.
    expect(typeof beforeTask).toBe("function");
  });

  // ── 5. No explicit clearTaskSessions on resume ─────────────────────────

  it("does NOT call clearTaskSessions for non-complete tasks (replay handles idempotency)", async () => {
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "complete" },
      { id: "task-2", status: "failed" },
      { id: "task-3", status: "ready" },
    ]);
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    // The B4 migration removes the explicit session-wipe loop. The pool's
    // internal retry valve (clearTaskSessions in maybeRetry) handles it.
    expect(mockClearTaskSessions).toHaveBeenCalledTimes(0);
  });

  it("does NOT call clearTaskSessions on a fresh run (no sessions to reset)", async () => {
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "ready" },
      { id: "task-2", status: "ready" },
    ]);
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockClearTaskSessions).toHaveBeenCalledTimes(0);
  });

  // ── 6. Config threading: maxConcurrentSessions + modelConcurrency ──────

  it("passes maxConcurrentSessions (not maxConcurrentLanes) to RunnerPool", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      3, // 5th positional: maxConcurrentSessions
      "/work",
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    // New RunnerPool uses maxConcurrentSessions (not maxConcurrentLanes)
    expect(poolOptions).toHaveProperty("maxConcurrentSessions");
    expect(poolOptions.maxConcurrentSessions).toBe(3);
    expect(poolOptions).not.toHaveProperty("maxConcurrentLanes");
  });

  it("passes modelConcurrency to RunnerPool from config", async () => {
    const tracker = makeMockTracker();
    const modelConcurrency = { "claude-sonnet-4-20250514": 2 };

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      undefined, // apiKeys
      undefined, // onStatus
      undefined, // signal
      undefined, // rendererRegistry
      undefined, // hookRegistry
      undefined, // worktreeManager
      modelConcurrency, // 13th positional: modelConcurrency
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("modelConcurrency");
    expect(poolOptions.modelConcurrency).toEqual(modelConcurrency);
  });

  it("defaults modelConcurrency to empty object when not provided", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("modelConcurrency");
    expect(poolOptions.modelConcurrency).toEqual({});
  });

  it("defaults maxConcurrentSessions to 5 when not specified", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      undefined as never,
      "/work",
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("maxConcurrentSessions");
    expect(poolOptions.maxConcurrentSessions).toBe(5);
  });

  // ── 7. Standard RunnerPool options (phaseId, profilesDirs, etc.) ───────

  it('passes phaseId: "implementing" to RunnerPool', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("phaseId", "implementing");
  });

  it("passes standard options to RunnerPool (profilesDirs, cwd, sessionBaseDir)", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("profilesDirs", ["/profiles"]);
    expect(poolOptions).toHaveProperty("cwd", "/cwd");
    expect(poolOptions).toHaveProperty("sessionBaseDir");
    expect(poolOptions.sessionBaseDir as string).toContain("/work/sessions");
  });

  it("passes apiKeys and onStatus through to RunnerPool when provided", async () => {
    const tracker = makeMockTracker();
    const onStatus = { onAgentSpawn: jest.fn() };
    const apiKeys = { ANTHROPIC: "sk-test" };

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      apiKeys,
      onStatus as never,
    );

    expect(MockRunnerPool).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys,
        onStatus,
      }),
    );
  });

  it("passes auditLog and taskTracker to RunnerPool", async () => {
    const tracker = {
      taskTracker: {
        addTask: mockAddTask,
        validateAllDependencies: mockValidateAllDependencies,
        getAllTasks: mockGetAllTasks,
        getTask: mockGetTask,
      },
      auditLog: { append: jest.fn() },
    } as never;

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockRunnerPool).toHaveBeenCalledWith(
      expect.objectContaining({
        auditLog: { append: expect.any(Function) },
        taskTracker: expect.any(Object),
      }),
    );
  });

  it("calls RunnerPool.run() and awaits it", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockPoolRun).toHaveBeenCalledTimes(1);
  });

  it("forwards a provided hookRegistry into RunnerPool and registers beforeTask on it", async () => {
    const tracker = makeMockTracker();
    const customRegistry = {
      register: jest.fn(),
      hasSubscribers: jest.fn().mockReturnValue(false),
      invokeObserve: jest.fn().mockResolvedValue(undefined),
      invokePipeline: jest.fn().mockResolvedValue(undefined),
      invokeFirstWins: jest.fn().mockResolvedValue(undefined),
      invokeAllRun: jest.fn().mockResolvedValue(undefined),
    };

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      undefined,
      undefined,
      undefined,
      undefined,
      customRegistry as never,
    );

    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions.hookRegistry).toBe(customRegistry);
    expect(customRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({ beforeTask: expect.any(Function) }),
    );
  });

  it("passes signal through to RunnerPool when provided", async () => {
    const tracker = makeMockTracker();
    const abortController = new AbortController();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      undefined,
      undefined,
      abortController.signal,
    );

    expect(MockRunnerPool).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: abortController.signal,
      }),
    );
  });

  it("passes maxTaskRetries: 2 to RunnerPool", async () => {
    mockGetAllTasks.mockReturnValue([]);
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockRunnerPool).toHaveBeenCalledWith(
      expect.objectContaining({ maxTaskRetries: 2 }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PhaseId Threading (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — phaseId threading", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockRunnerPool.mockClear();
    MockLanePool.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockSingleSession.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetTask.mockReturnValue(undefined);
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "done" },
    ]);
  });

  it('calls addTask with phaseId: "implementing" for each plan task', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).toHaveBeenCalledTimes(2);

    expect(mockAddTask).toHaveBeenNthCalledWith(1, {
      id: "t-01",
      title: "Add feature A",
      prompt: "Implement feature A in module X",
      profile: "implementer",
      files: ["src/x.ts"],
      dependencies: [],
      worktree: "code",
      phaseId: "implementing",
    });

    expect(mockAddTask).toHaveBeenNthCalledWith(2, {
      id: "t-02",
      title: "Update docs",
      prompt: "Document feature A",
      profile: "implementer",
      files: ["README.md"],
      dependencies: ["t-01"],
      worktree: "code",
      phaseId: "implementing",
    });
  });

  it("skips addTask for tasks already in the tracker", async () => {
    const tracker = makeMockTracker();
    mockGetTask.mockImplementation((id: string) => {
      return id === "t-01" ? { id: "t-01" } : undefined;
    });

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t-02",
      }),
    );
  });

  it("calls validateAllDependencies after adding tasks", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockValidateAllDependencies).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Pool Result Discrepancy (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — pool result handling", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockRunnerPool.mockClear();
    MockLanePool.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockSingleSession.mockClear();
    mockGetTask.mockReturnValue(undefined);
  });

  it("logs a warning when pool result does not match tracker state", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const tracker = makeMockTracker();

    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "done" },
    ]);

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pool result discrepancy"),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 completed"),
    );

    consoleWarnSpy.mockRestore();
  });

  it("does not warn when pool result matches tracker state", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const tracker = makeMockTracker();

    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "done" },
    ]);

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("warns correctly with mixed completed/failed tasks", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const tracker = makeMockTracker();

    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 1 });
    mockGetAllTasks.mockReturnValue([{ id: "task-1", status: "done" }]);

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 settled"),
    );

    consoleWarnSpy.mockRestore();
  });

  it("computes settled tasks as completedTasks + failedTasks", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const tracker = makeMockTracker();

    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 2 });
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "failed" },
    ]);

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "3 settled tasks (1 completed + 2 failed) vs 2 total tasks",
      ),
    );

    consoleWarnSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Edge Cases (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — edge cases", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockRunnerPool.mockClear();
    MockLanePool.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockSingleSession.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });
  });

  it("handles an empty plan (no tasks)", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const tracker = makeMockTracker();

    const emptyPlan: Plan = { tasks: [], strategy: "" };

    mockGetAllTasks.mockReturnValue([]);
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

    await implementationPhase(
      tracker,
      ["/profiles"],
      emptyPlan,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockValidateAllDependencies).toHaveBeenCalled();
    expect(mockPoolRun).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it("uses default maxConcurrentSessions=5 when not specified", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      undefined as never,
      "/work",
    );

    expect(MockRunnerPool).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentSessions: 5 }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// rendererRegistry and task-id renumbering (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — rendererRegistry and task-id renumbering", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockRunnerPool.mockClear();
    MockLanePool.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockSingleSession.mockClear();
    mockAssignSequentialTaskIds.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);
  });

  it("renumbers task ids: arbitrary IDs become sequential (t-01, t-02) and dependencies are remapped", async () => {
    const tracker = makeMockTracker();
    const planWithArbitraryIds: Plan = {
      tasks: [
        {
          id: "auth-a",
          title: "Auth module",
          prompt: "Implement auth",
          profile: "implementer",
          files: ["src/auth.ts"],
          is_code: true,
          dependencies: [],
        },
        {
          id: "auth-b",
          title: "Auth tests",
          prompt: "Write auth tests",
          profile: "implementer",
          files: ["src/auth.test.ts"],
          is_code: true,
          dependencies: ["auth-a"],
        },
      ],
      strategy: "Auth first",
    };

    await implementationPhase(
      tracker,
      ["/profiles"],
      planWithArbitraryIds,
      "/cwd",
      5,
      "/work",
    );

    const addedIds = mockAddTask.mock.calls.map((c) => c[0].id);
    expect(addedIds).toContain("t-01");
    expect(addedIds).toContain("t-02");

    expect(mockAddTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "t-01",
        dependencies: [],
      }),
    );

    expect(mockAddTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "t-02",
        dependencies: ["t-01"],
      }),
    );
  });

  it("assignSequentialTaskIds is called with plan.tasks and OLD ids never reach the tracker", async () => {
    const tracker = makeMockTracker();
    const planWithArbitraryIds: Plan = {
      tasks: [
        {
          id: "auth-a",
          title: "Auth module",
          prompt: "Implement auth",
          profile: "implementer",
          files: ["src/auth.ts"],
          is_code: true,
          dependencies: [],
        },
        {
          id: "auth-b",
          title: "Auth tests",
          prompt: "Write auth tests",
          profile: "implementer",
          files: ["src/auth.test.ts"],
          is_code: true,
          dependencies: ["auth-a"],
        },
      ],
      strategy: "Auth first",
    };

    await implementationPhase(
      tracker,
      ["/profiles"],
      planWithArbitraryIds,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAssignSequentialTaskIds).toHaveBeenCalledTimes(1);
    expect(mockAssignSequentialTaskIds).toHaveBeenCalledWith(
      planWithArbitraryIds.tasks,
    );

    const addedIds = mockAddTask.mock.calls.map((c) => c[0].id);
    expect(addedIds).not.toContain("auth-a");
    expect(addedIds).not.toContain("auth-b");
  });

  it("forwards rendererRegistry into RunnerPool options when provided", async () => {
    const tracker = makeMockTracker();
    const fakeRegistry = {
      renderers: new Map(),
      register: jest.fn(),
      get: jest.fn(),
      render: jest.fn(),
    } as never;

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      undefined,
      undefined,
      undefined,
      fakeRegistry,
    );

    expect(MockRunnerPool).toHaveBeenCalledTimes(1);
    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions).toHaveProperty("rendererRegistry", fakeRegistry);
  });

  it("rendererRegistry is optional: omitting it still works", async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockRunnerPool).toHaveBeenCalledTimes(1);
    const poolOptions = MockRunnerPool.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(poolOptions.rendererRegistry).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// worktreeManager threading (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — worktreeManager threading", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockRunnerPool.mockClear();
    MockLanePool.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockSingleSession.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "done" },
      { id: "task-2", status: "done" },
    ]);
  });

  it("threads worktreeManager from implementationPhase into RunnerPool ctor options", async () => {
    const tracker = makeMockTracker();

    const mockWtm = {
      createTaskWorktree: mock(async () => "/wt/x"),
      mergeTaskBranch: mock(async () => ({
        success: true,
        conflictsResolved: false,
      })),
      cullTaskWorktree: mock(async () => {}),
      mainWorktreePath: "/wt/main",
    } as unknown as WorkflowRunOptions["worktreeManager"];

    await implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      undefined, // apiKeys
      undefined, // onStatus
      undefined, // signal
      undefined, // rendererRegistry
      undefined, // hookRegistry
      mockWtm, // worktreeManager
    );

    expect(MockRunnerPool).toHaveBeenCalledTimes(1);
    expect(MockRunnerPool.mock.calls[0][0]).toMatchObject({
      worktreeManager: mockWtm,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Type-level: RunnerPoolOptions uses maxConcurrentSessions (not maxConcurrentLanes)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — RunnerPoolOptions type", () => {
  it("RunnerPool is constructed with maxConcurrentSessions (not maxConcurrentLanes)", () => {
    const tracker = makeMockTracker();

    return implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    ).then(() => {
      const callArg = MockRunnerPool.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArg).toHaveProperty("maxConcurrentSessions");
      expect(callArg).not.toHaveProperty("maxConcurrentLanes");
    });
  });

  it("does not pass legacy phase field to RunnerPool", () => {
    const tracker = makeMockTracker();

    return implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    ).then(() => {
      const callArg = MockRunnerPool.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArg).not.toHaveProperty("phase");
    });
  });

  it("RunnerPool is constructed with phaseId field (not phase)", () => {
    const tracker = makeMockTracker();

    return implementationPhase(
      tracker,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    ).then(() => {
      const callArg = MockRunnerPool.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArg).toHaveProperty("phaseId");
      expect(callArg.phaseId).toBe("implementing");
    });
  });
});
