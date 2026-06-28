// ─── Implementation Phase Tests (E4 migration) ─────────────────────────────
//
// Tests for implementation.ts after E4 migration:
//   • TaskGraph replaces WorkflowStatusTracker/TaskTracker
//   • SessionScheduler replaces RunnerPool
//   • taskGraph.addTask(task, runnerFactory) replaces tracker.taskTracker.addTask
//   • resolveImplementationRunner returns a SessionPlanFactory (() => SessionPlanRunner)
//   • beforeTask hook returns { runner: SessionPlanFactory, sessionPlan }
//   • SessionGate({ total, perModel }) replaces maxConcurrentSessions + modelConcurrency
//   • Cycle detection at addTask time; failDeadlockedTasks at scheduler.run() startup
//   • No explicit clearTaskSessions — replay idempotency handles resume
//
// Builds on: kb-3 (runSession), kb-4 (reviewRunner/linearRunner/singleSession),
// kb-7 (SessionScheduler), kb-12 (createEnginMock additions).
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from "bun:test";
import type {
  StatusCallbacks,
  TaskGraph,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import { createEnginMock } from "./engin-mock";

// ─── Mock @harms-haus/engin-engine ──────────────────────────────────────────
//
// The mock provides SessionScheduler, SessionGate, TaskGraph, AuditLog,
// singleSession/reviewRunner/linearRunner (callable-factory versions matching
// the real SessionPlanFactory contract), plus loadProfilesFromDirs and
// assignSequentialTaskIds (renumbering).

// ── TaskGraph method mocks (shared across makeMockTaskGraph instances) ──
const mockAddTask = jest.fn<(task: Record<string, unknown>, runnerFactory: unknown) => void>();
const mockGetTask = jest.fn<(id: string) => unknown>();
const mockGetAllTasks = jest.fn<() => { id: string; status: string }[]>();

// ── SessionScheduler mock ────────────────────────────────────────────────
const mockSchedulerRun =
  jest.fn<() => Promise<{ completedTasks: number; failedTasks: number }>>();

const MockSessionScheduler = jest.fn().mockImplementation(() => ({
  run: mockSchedulerRun,
}));

// ── SessionGate mock (captures constructor options) ──────────────────────
const MockSessionGate = jest.fn().mockImplementation(() => ({
  run: jest.fn(),
  acquire: jest.fn().mockReturnValue(true),
  release: jest.fn(),
  canStart: jest.fn().mockReturnValue(true),
  availableTotal: jest.fn().mockReturnValue(5),
}));

// ── AuditLog mock ────────────────────────────────────────────────────────
const MockAuditLog = jest.fn().mockImplementation(() => ({
  append: jest.fn().mockResolvedValue(undefined),
}));

// ── Runner factories: callable-factory versions matching real contract ──
// singleSession(spec) → SessionPlanFactory (() => SessionPlanRunner).
// Production code calls singleSession(spec)() so the mock must return
// a callable that yields a SessionPlanRunner.
const mockSingleSession = jest.fn().mockImplementation((spec: Record<string, unknown>) =>
  jest.fn(() => ({
    plan: async function* () {
      yield [spec];
    },
    execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
  })),
);

// reviewRunner(executeSpec, reviewSpec, opts?) → SessionPlanFactory.
const mockReviewRunner = jest.fn().mockImplementation(
  (_executeSpec: unknown, _reviewSpec: unknown, _opts?: unknown) =>
    jest.fn(() => ({
      plan: async function* () {
        yield [];
      },
      execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
    })),
);

// linearRunner(children) → SessionPlanFactory.
const mockLinearRunner = jest.fn().mockImplementation((_children: unknown[]) =>
  jest.fn(() => ({
    plan: async function* () {
      yield [];
    },
    execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
  })),
);

// ── assignSequentialTaskIds: renumbers like the real function ────────────
const mockAssignSequentialTaskIds = jest.fn(
  (tasks: { id: string; dependencies: string[] }[]) => {
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

// ── loadProfilesFromDirs ─────────────────────────────────────────────────
const mockLoadProfilesFromDirs = jest.fn().mockResolvedValue(new Map());

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),

  // Override constructors with our capturing mocks
  SessionScheduler: MockSessionScheduler,
  SessionGate: MockSessionGate,
  AuditLog: MockAuditLog,

  // Callable-factory runner mocks (real contract: return SessionPlanFactory)
  singleSession: mockSingleSession,
  reviewRunner: mockReviewRunner,
  linearRunner: mockLinearRunner,

  // Override utilities
  assignSequentialTaskIds: mockAssignSequentialTaskIds,
  loadProfilesFromDirs: mockLoadProfilesFromDirs,
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

function makeMockTaskGraph(): TaskGraph {
  return {
    addTask: mockAddTask,
    getTask: mockGetTask,
    getAllTasks: mockGetAllTasks,
  } as unknown as TaskGraph;
}

/**
 * Extract the `beforeTask` hook registered by implementationPhase. Searches
 * the hookRegistry passed to SessionScheduler for a `register` call that
 * includes a `beforeTask` subscriber.
 */
function extractBeforeTaskHook(): (args: {
  task: unknown;
}) => { runner: unknown; sessionPlan: unknown } | undefined {
  const schedulerOptions = MockSessionScheduler.mock.calls[0][0] as Record<
    string,
    unknown
  >;
  expect(schedulerOptions).toHaveProperty("hookRegistry");
  const registry = schedulerOptions.hookRegistry as {
    register: { mock: { calls: unknown[][] } };
  };
  for (const call of registry.register.mock.calls) {
    const hooks = call[0] as Record<string, unknown> | undefined;
    if (hooks && "beforeTask" in hooks) {
      const value = hooks.beforeTask;
      const fn = Array.isArray(value) ? value[0] : value;
      if (typeof fn === "function") return fn as never;
    }
  }
  throw new Error("beforeTask hook was not registered on the hookRegistry");
}

// ══════════════════════════════════════════════════════════════════════════
// E4 MIGRATION: SessionScheduler + TaskGraph
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — E4 migration: SessionScheduler + TaskGraph", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockGetTask.mockClear();
    mockGetAllTasks.mockClear();
    mockSchedulerRun.mockClear();
    MockSessionScheduler.mockClear();
    MockSessionGate.mockClear();
    MockAuditLog.mockClear();
    mockSingleSession.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockAssignSequentialTaskIds.mockClear();
    mockLoadProfilesFromDirs.mockClear();

    // Defaults
    mockSchedulerRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetTask.mockReturnValue(undefined);
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);
  });

  // ── 1. SessionScheduler constructed (not RunnerPool) ──────────────────

  it("constructs SessionScheduler", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockSessionScheduler).toHaveBeenCalledTimes(1);
  });

  // ── 2. Tasks loaded into TaskGraph via addTask(task, runnerFactory) ────

  it("adds each plan task to the task graph with a runnerFactory", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).toHaveBeenCalledTimes(2);

    // First task — verify task object + runnerFactory
    const firstCall = mockAddTask.mock.calls[0];
    expect(firstCall[0]).toMatchObject({
      id: "t-01",
      title: "Add feature A",
      worktree: "code",
      phaseId: "implementing",
      status: "ready",
    });
    expect(typeof firstCall[1]).toBe("function"); // runnerFactory

    // Second task
    const secondCall = mockAddTask.mock.calls[1];
    expect(secondCall[0]).toMatchObject({
      id: "t-02",
      title: "Update docs",
      worktree: "code",
      phaseId: "implementing",
    });
    expect(typeof secondCall[1]).toBe("function");
  });

  it("skips addTask for tasks already in the graph (resume)", async () => {
    const taskGraph = makeMockTaskGraph();
    mockGetTask.mockImplementation((id: string) =>
      id === "t-01" ? { task: { id: "t-01" } } : undefined,
    );

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask.mock.calls[0][0]).toMatchObject({ id: "t-02" });
  });

  // ── 3. Runner tree: code task = linearRunner([singleSession, reviewRunner]) ──

  it("builds code-task tree as linearRunner([singleSession(write-tests)(), reviewRunner(execute, review)()])", async () => {
    const taskGraph = makeMockTaskGraph();

    // Use a single code task so mock counts are unambiguous
    const codePlan: Plan = {
      tasks: [
        {
          id: "code-a",
          title: "Code task",
          prompt: "Do the thing",
          profile: "implementer",
          files: ["src/a.ts"],
          is_code: true,
          dependencies: [],
        },
      ],
      strategy: "",
    };

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      codePlan,
      "/cwd",
      5,
      "/work",
    );

    // singleSession called once for write-tests spec
    expect(mockSingleSession).toHaveBeenCalledTimes(1);
    expect(mockSingleSession.mock.calls[0][0]).toMatchObject({
      role: "write-tests",
      profile: "test-writer",
    });

    // reviewRunner called once for execute → review loop
    expect(mockReviewRunner).toHaveBeenCalledTimes(1);
    expect(mockReviewRunner.mock.calls[0][0]).toMatchObject({
      role: "execute",
    });
    expect(mockReviewRunner.mock.calls[0][1]).toMatchObject({
      role: "review",
      profile: "implement-reviewer",
    });

    // linearRunner called once with 2 children
    expect(mockLinearRunner).toHaveBeenCalledTimes(1);
    const linearChildren = mockLinearRunner.mock.calls[0][0] as unknown[];
    expect(linearChildren).toHaveLength(2);
  });

  // ── 4. Runner tree: non-code task = reviewRunner(execute, review) ───────

  it("builds non-code tree as reviewRunner(execute, review) with no singleSession", async () => {
    const taskGraph = makeMockTaskGraph();

    const nonCodePlan: Plan = {
      tasks: [
        {
          id: "doc-a",
          title: "Doc task",
          prompt: "Write docs",
          profile: "implementer",
          files: ["README.md"],
          is_code: false,
          dependencies: [],
        },
      ],
      strategy: "",
    };

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      nonCodePlan,
      "/cwd",
      5,
      "/work",
    );

    // singleSession NOT called for non-code tasks
    expect(mockSingleSession).toHaveBeenCalledTimes(0);
    // linearRunner NOT called
    expect(mockLinearRunner).toHaveBeenCalledTimes(0);

    // reviewRunner called once
    expect(mockReviewRunner).toHaveBeenCalledTimes(1);
    expect(mockReviewRunner.mock.calls[0][0]).toMatchObject({
      role: "execute",
    });
    expect(mockReviewRunner.mock.calls[0][1]).toMatchObject({
      role: "review",
      profile: "implement-reviewer",
    });
  });

  // ── 5. Profile substitution ───────────────────────────────────────────

  it("substitutes custom profile for the execute (implementer) session", async () => {
    const taskGraph = makeMockTaskGraph();

    const customProfilePlan: Plan = {
      tasks: [
        {
          id: "code-custom",
          title: "Custom profile code task",
          prompt: "Do it",
          profile: "implementer-lite",
          files: ["src/b.ts"],
          is_code: true,
          dependencies: [],
        },
      ],
      strategy: "",
    };

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      customProfilePlan,
      "/cwd",
      5,
      "/work",
    );

    // reviewRunner execute spec uses the custom profile
    expect(mockReviewRunner).toHaveBeenCalledTimes(1);
    const executeSpec = mockReviewRunner.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(executeSpec.role).toBe("execute");
    expect(executeSpec.profile).toBe("implementer-lite");

    // Reviewer profile is always implement-reviewer
    const reviewSpec = mockReviewRunner.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(reviewSpec.profile).toBe("implement-reviewer");

    // Test-writer profile is always test-writer
    expect(mockSingleSession).toHaveBeenCalledTimes(1);
    const writeTestsSpec = mockSingleSession.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(writeTestsSpec.profile).toBe("test-writer");
  });

  // ── 6. beforeTask hook returns { runner: factory, sessionPlan } ────────

  it("beforeTask hook returns { runner, sessionPlan } for code tasks", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const beforeTask = extractBeforeTaskHook();

    const codeTask = {
      id: "t-01",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
    } as never;
    const result = beforeTask({ task: codeTask });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("runner");
    expect(result).toHaveProperty("sessionPlan");
    // runner is a SessionPlanFactory (function)
    expect(typeof (result as { runner: unknown }).runner).toBe("function");
    // sessionPlan is an array of entries
    const plan = (result as { sessionPlan: unknown[] }).sessionPlan;
    expect(Array.isArray(plan)).toBe(true);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toMatchObject({ role: "write-tests" });
    expect(plan[1]).toMatchObject({ role: "execute" });
    expect(plan[2]).toMatchObject({ role: "review" });
  });

  it("beforeTask hook returns { runner, sessionPlan } for non-code tasks", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const beforeTask = extractBeforeTaskHook();

    const nonCodeTask = {
      id: "t-02",
      title: "",
      prompt: "",
      profile: "implementer",
      files: [],
      dependencies: [],
    } as never;
    const result = beforeTask({ task: nonCodeTask });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("runner");
    expect(typeof (result as { runner: unknown }).runner).toBe("function");

    const plan = (result as { sessionPlan: unknown[] }).sessionPlan;
    expect(Array.isArray(plan)).toBe(true);
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ role: "execute" });
    expect(plan[1]).toMatchObject({ role: "review" });
  });

  // ── 7. No clearTaskSessions on resume ─────────────────────────────────

  it("does NOT call clearTaskSessions for non-complete tasks (replay handles idempotency)", async () => {
    mockGetAllTasks.mockReturnValue([
      { id: "task-1", status: "complete" },
      { id: "task-2", status: "failed" },
      { id: "task-3", status: "ready" },
    ]);
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    // No explicit session-wipe; the scheduler handles retry-wipes internally.
    // (clearTaskSessions is not imported by implementation.ts anymore.)
    expect(MockSessionScheduler).toHaveBeenCalledTimes(1);
  });

  // ── 8. Config threading: gate total + perModel ────────────────────────

  it("passes maxConcurrentTasks to SessionGate.total", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      3,
      "/work",
    );

    expect(MockSessionGate).toHaveBeenCalledTimes(1);
    const gateOpts = MockSessionGate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(gateOpts.total).toBe(3);
  });

  it("passes modelConcurrency to SessionGate.perModel", async () => {
    const taskGraph = makeMockTaskGraph();
    const modelConcurrency = { "claude-sonnet-4-20250514": 2 };

    await implementationPhase(
      taskGraph,
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
      modelConcurrency, // 13th positional
    );

    const gateOpts = MockSessionGate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(gateOpts.perModel).toEqual(modelConcurrency);
  });

  it("defaults modelConcurrency to empty object when not provided", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const gateOpts = MockSessionGate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(gateOpts.perModel).toEqual({});
  });

  it("defaults maxConcurrentTasks to 5 when undefined", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      undefined as never,
      "/work",
    );

    const gateOpts = MockSessionGate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(gateOpts.total).toBe(5);
  });

  // ── 9. Standard SessionScheduler options ──────────────────────────────

  it('passes phaseId: "implementing" to SessionScheduler', async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const opts = MockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts.phaseId).toBe("implementing");
  });

  it("passes graph, gate, profiles, sessionBaseDir, cwd to SessionScheduler", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockSessionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        graph: taskGraph,
        cwd: "/cwd",
        sessionBaseDir: expect.stringContaining("/work/sessions"),
      }),
    );
    // gate is the SessionGate instance
    const opts = MockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts).toHaveProperty("gate");
    expect(opts).toHaveProperty("profiles");
    expect(opts).toHaveProperty("activeSessions");
  });

  it("loads profiles from profilesDirs", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles", "/more-profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockLoadProfilesFromDirs).toHaveBeenCalledTimes(1);
    expect(mockLoadProfilesFromDirs).toHaveBeenCalledWith([
      "/profiles",
      "/more-profiles",
    ]);
  });

  it("passes apiKeys and onStatus through to SessionScheduler when provided", async () => {
    const taskGraph = makeMockTaskGraph();
    const onStatus = { onAgentSpawn: jest.fn() } as never;
    const apiKeys = { ANTHROPIC: "sk-test" };

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      apiKeys,
      onStatus as StatusCallbacks,
    );

    expect(MockSessionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeys, onStatus }),
    );
  });

  it("constructs an AuditLog from workDir and threads it into SessionScheduler", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(MockAuditLog).toHaveBeenCalledTimes(1);
    expect(MockAuditLog).toHaveBeenCalledWith("/work");
    const opts = MockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts).toHaveProperty("auditLog");
  });

  it("calls SessionScheduler.run() and awaits it", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockSchedulerRun).toHaveBeenCalledTimes(1);
  });

  it("forwards a provided hookRegistry into SessionScheduler and registers beforeTask on it", async () => {
    const taskGraph = makeMockTaskGraph();
    const customRegistry = {
      register: jest.fn(),
      hasSubscribers: jest.fn().mockReturnValue(false),
      invokeObserve: jest.fn().mockResolvedValue(undefined),
      invokePipeline: jest.fn().mockResolvedValue(undefined),
      invokeFirstWins: jest.fn().mockResolvedValue(undefined),
      invokeAllRun: jest.fn().mockResolvedValue(undefined),
    };

    await implementationPhase(
      taskGraph,
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

    const opts = MockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts.hookRegistry).toBe(customRegistry);
    expect(customRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({ beforeTask: expect.any(Function) }),
    );
  });

  it("passes signal through to SessionScheduler when provided", async () => {
    const taskGraph = makeMockTaskGraph();
    const abortController = new AbortController();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
      undefined,
      undefined,
      abortController.signal,
    );

    expect(MockSessionScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PhaseId Threading (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — phaseId threading", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockGetTask.mockClear();
    mockGetAllTasks.mockClear();
    mockSchedulerRun.mockClear();
    MockSessionScheduler.mockClear();
    MockSessionGate.mockClear();
    MockAuditLog.mockClear();
    mockSingleSession.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockAssignSequentialTaskIds.mockClear();
    mockSchedulerRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetTask.mockReturnValue(undefined);
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);
  });

  it('calls addTask with phaseId: "implementing" for each plan task', async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).toHaveBeenCalledTimes(2);

    expect(mockAddTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "t-01",
        title: "Add feature A",
        prompt: "Implement feature A in module X",
        profile: "implementer",
        files: ["src/x.ts"],
        dependencies: [],
        worktree: "code",
        phaseId: "implementing",
        status: "ready",
      }),
      expect.any(Function),
    );

    expect(mockAddTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "t-02",
        title: "Update docs",
        prompt: "Document feature A",
        profile: "implementer",
        files: ["README.md"],
        dependencies: ["t-01"],
        worktree: "code",
        phaseId: "implementing",
        status: "ready",
      }),
      expect.any(Function),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scheduler Result Handling (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — scheduler result handling", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockGetTask.mockClear();
    mockGetAllTasks.mockClear();
    mockSchedulerRun.mockClear();
    MockSessionScheduler.mockClear();
    MockSessionGate.mockClear();
    MockAuditLog.mockClear();
    mockSingleSession.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockGetTask.mockReturnValue(undefined);
  });

  it("logs a warning when scheduler result does not match graph state", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const taskGraph = makeMockTaskGraph();

    mockSchedulerRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Scheduler result discrepancy"),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 completed"),
    );

    consoleWarnSpy.mockRestore();
  });

  it("does not warn when scheduler result matches graph state", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const taskGraph = makeMockTaskGraph();

    mockSchedulerRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);

    await implementationPhase(
      taskGraph,
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
    const taskGraph = makeMockTaskGraph();

    mockSchedulerRun.mockResolvedValue({ completedTasks: 1, failedTasks: 1 });
    mockGetAllTasks.mockReturnValue([{ id: "t-01", status: "done" }]);

    await implementationPhase(
      taskGraph,
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
    const taskGraph = makeMockTaskGraph();

    mockSchedulerRun.mockResolvedValue({ completedTasks: 1, failedTasks: 2 });
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "failed" },
    ]);

    await implementationPhase(
      taskGraph,
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
    mockGetTask.mockClear();
    mockGetAllTasks.mockClear();
    mockSchedulerRun.mockClear();
    MockSessionScheduler.mockClear();
    MockSessionGate.mockClear();
    MockAuditLog.mockClear();
    mockSingleSession.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockSchedulerRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it("handles an empty plan (no tasks)", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const taskGraph = makeMockTaskGraph();

    const emptyPlan: Plan = { tasks: [], strategy: "" };

    mockGetAllTasks.mockReturnValue([]);

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      emptyPlan,
      "/cwd",
      5,
      "/work",
    );

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockSchedulerRun).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it("uses default maxConcurrentTasks=5 when not specified", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      undefined as never,
      "/work",
    );

    const gateOpts = MockSessionGate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(gateOpts.total).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// RendererRegistry and task-id renumbering (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — rendererRegistry and task-id renumbering", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockGetTask.mockClear();
    mockGetAllTasks.mockClear();
    mockSchedulerRun.mockClear();
    MockSessionScheduler.mockClear();
    MockSessionGate.mockClear();
    MockAuditLog.mockClear();
    mockSingleSession.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockAssignSequentialTaskIds.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockSchedulerRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);
  });

  it("renumbers task ids: arbitrary IDs become sequential (t-01, t-02) and dependencies are remapped", async () => {
    const taskGraph = makeMockTaskGraph();
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
      taskGraph,
      ["/profiles"],
      planWithArbitraryIds,
      "/cwd",
      5,
      "/work",
    );

    const addedIds = mockAddTask.mock.calls.map((c) => c[0].id as string);
    expect(addedIds).toContain("t-01");
    expect(addedIds).toContain("t-02");

    expect(mockAddTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "t-01", dependencies: [] }),
      expect.any(Function),
    );

    expect(mockAddTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "t-02", dependencies: ["t-01"] }),
      expect.any(Function),
    );
  });

  it("assignSequentialTaskIds is called with plan.tasks and OLD ids never reach the graph", async () => {
    const taskGraph = makeMockTaskGraph();
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
      taskGraph,
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

    const addedIds = mockAddTask.mock.calls.map((c) => c[0].id as string);
    expect(addedIds).not.toContain("auth-a");
    expect(addedIds).not.toContain("auth-b");
  });

  it("forwards rendererRegistry into SessionScheduler options when provided", async () => {
    const taskGraph = makeMockTaskGraph();
    const fakeRegistry = {
      renderers: new Map(),
      register: jest.fn(),
      get: jest.fn(),
      render: jest.fn(),
    } as never;

    await implementationPhase(
      taskGraph,
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

    expect(MockSessionScheduler).toHaveBeenCalledTimes(1);
    const opts = MockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts.rendererRegistry).toBe(fakeRegistry);
  });

  it("rendererRegistry is optional: omitting it still works", async () => {
    const taskGraph = makeMockTaskGraph();

    await implementationPhase(
      taskGraph,
      ["/profiles"],
      SAMPLE_PLAN,
      "/cwd",
      5,
      "/work",
    );

    const opts = MockSessionScheduler.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts.rendererRegistry).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// worktreeManager threading (preserved coverage)
// ══════════════════════════════════════════════════════════════════════════

describe("implementationPhase — worktreeManager threading", () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockGetTask.mockClear();
    mockGetAllTasks.mockClear();
    mockSchedulerRun.mockClear();
    MockSessionScheduler.mockClear();
    MockSessionGate.mockClear();
    MockAuditLog.mockClear();
    mockSingleSession.mockClear();
    mockReviewRunner.mockClear();
    mockLinearRunner.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockSchedulerRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: "t-01", status: "done" },
      { id: "t-02", status: "done" },
    ]);
  });

  it("threads worktreeManager into SessionScheduler ctor options", async () => {
    const taskGraph = makeMockTaskGraph();

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
      taskGraph,
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

    expect(MockSessionScheduler).toHaveBeenCalledTimes(1);
    expect(MockSessionScheduler.mock.calls[0][0]).toMatchObject({
      worktreeManager: mockWtm,
    });
  });
});
