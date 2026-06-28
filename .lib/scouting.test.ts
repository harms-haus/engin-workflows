// ─── Scouting Phase Tests ────────────────────────────────────────────────────
//
// Tests for the migrated scouting.ts that uses TaskGraph + SessionScheduler
// (SessionPlan contract) instead of the legacy TaskTracker + RunnerPool.
//
// session-utils.ts now calls `runSession` directly (bypassing the old
// singleSession callable-runner indirection), so coordinator/review assertions
// check `runSession` calls rather than `singleSession`.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import type { StatusCallbacks, TaskGraph } from "@harms-haus/engin-engine";
import { createEnginMock } from "./engin-mock";

// ─── Mock @harms-haus/engin-engine ────────────────────────────────────────
//
// We mock the ENTIRE module via createEnginMock(). The real engine's
// singleSession/linearRunner return SessionPlanFactory (() => SessionPlanRunner);
// the base mock collapses that indirection (returns SessionPlanRunner directly).
// scouting.ts's runnerFactory calls singleSession(spec)() — invoking the
// factory — so we override singleSession/linearRunner here to return CALLABLE
// factories that match the real contract.
//
// SessionScheduler is overridden to capture construction options.
// TaskGraph instances are created per-test by makeMockTaskGraph().

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  // singleSession(spec) → SessionPlanFactory (() => SessionPlanRunner).
  // Production code calls singleSession(spec)() so the mock must return
  // a callable that yields a SessionPlanRunner.
  singleSession: jest.fn().mockImplementation((spec: Record<string, unknown>) =>
    jest.fn(() => ({
      plan: async function* () {
        yield [spec];
      },
      execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
    })),
  ),
  // linearRunner(children) → SessionPlanFactory (() => SessionPlanRunner).
  linearRunner: jest.fn().mockImplementation((_children: unknown[]) =>
    jest.fn(() => ({
      plan: async function* () {
        yield [];
      },
      execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
    })),
  ),
}));

// Import the engine to get the ACTUAL mock instances used by the implementation
const engineModule = await import("@harms-haus/engin-engine");

// References to the shared mock instances (read from the cached engine module)
type Spy = ReturnType<typeof mock>;
const mockRunSession = engineModule.runSession as unknown as Spy;
const mockSingleSession = engineModule.singleSession as unknown as Spy;
const mockLinearRunner = engineModule.linearRunner as unknown as Spy;
const mockSessionScheduler = engineModule.SessionScheduler as unknown as Spy;

// Dynamic import after mock is set up
const { scoutingPhase, scoutingReviewPhase } = await import("./scouting");
import type { ScoutingReview } from "./schemas";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a mock TaskGraph that behaves like the real one for the operations
 * scoutingPhase uses: addTask (stores), getTask (lookup), getAllTasks (list).
 */
function makeMockTaskGraph(): TaskGraph {
  const entries = new Map<string, { task: Record<string, unknown> }>();
  return {
    addTask: mock((task: Record<string, unknown>) => {
      entries.set(task.id as string, { task });
    }),
    getTask: mock((id: string) => entries.get(id)),
    getAllTasks: mock(() => Array.from(entries.values())),
  } as unknown as TaskGraph;
}

function makeStatusCallbacksSpy() {
  return {
    onTaskRegister: mock(() => {}),
    onTaskStart: mock(() => {}),
    onTaskComplete: mock(() => {}),
    onTaskRejected: mock(() => {}),
    onDecision: mock(() => {}),
    onWorkflowData: mock(() => {}),
  } as unknown as StatusCallbacks;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("scoutingPhase", () => {
  beforeEach(() => {
    mockRunSession.mockClear();
    mockSingleSession.mockClear();
    mockLinearRunner.mockClear();
    mockSessionScheduler.mockClear();
  });

  // ─── Pre-defined topics path (follow-up round) ────────────────────────

  describe("when topics are pre-defined (follow-up round)", () => {
    it("skips the scout-coordinator and adds one scout task per topic to the SHARED graph", async () => {
      const taskGraph = makeMockTaskGraph();
      const topics = [
        {
          topic: "API Design",
          rationale: "Need to understand API endpoints",
          files: ["src/api/"],
        },
        {
          topic: "Database",
          rationale: "Inspect schema",
          files: ["src/db/"],
        },
      ];

      await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Implement feature X",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { topics, round: 1 },
      );

      // Coordinator should NOT have been called — runSession is not invoked
      expect(mockRunSession).not.toHaveBeenCalled();
      // One scout task per topic lands on the SHARED graph (phaseId 'scouting')
      const addTaskCalls = (taskGraph.addTask as Spy).mock.calls as Array<
        [Record<string, unknown>, unknown]
      >;
      expect(addTaskCalls).toHaveLength(2);
      expect(addTaskCalls[0]![0].id).toBe("scout-api-design");
      expect(addTaskCalls[0]![0].phaseId).toBe("scouting");
      expect(addTaskCalls[0]![0].profile).toBe("scout");
      expect(addTaskCalls[1]![0].id).toBe("scout-database");
    });

    it("does not re-add a task whose slug already exists on the shared graph", async () => {
      const taskGraph = makeMockTaskGraph();
      const topics = [
        { topic: "API Design", rationale: "x", files: ["a"] },
        { topic: "API-Design", rationale: "y", files: ["b"] },
      ];

      await expect(
        scoutingPhase(
          taskGraph,
          ["/profiles"],
          "Task",
          "/cwd",
          5,
          "/workdir",
          undefined,
          undefined,
          undefined,
          {
            topics,
            round: 0,
          },
        ),
      ).resolves.toBeUndefined();

      const addTaskCalls = (taskGraph.addTask as Spy).mock.calls;
      expect(addTaskCalls).toHaveLength(1);
      // runSession must not be called in the follow-up path
      expect(mockRunSession).not.toHaveBeenCalled();
    });
  });

  // ─── Scout-coordinator path (first round) ─────────────────────────────────

  describe("when no topics are provided (first round)", () => {
    it("uses runSession for the scout-coordinator", async () => {
      const taskGraph = makeMockTaskGraph();

      await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { round: 0 },
      );

      // The coordinator runs via runSession (session-utils calls it directly).
      expect(mockRunSession).toHaveBeenCalledTimes(1);
      const ctx = mockRunSession.mock.calls[0]![0] as Record<string, unknown>;
      const spec = ctx.spec as Record<string, unknown>;
      expect(spec.profile).toBe("scout-coordinator");
      expect(spec.runnerRole).toBe("coordinate");
      expect(spec.isReadOnly).toBe(true);
    });

    it("passes the correct prompt to runSession for the coordinator", async () => {
      const taskGraph = makeMockTaskGraph();

      await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Implement feature X",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { round: 0 },
      );

      expect(mockRunSession).toHaveBeenCalledTimes(1);
      const ctx = mockRunSession.mock.calls[0]![0] as Record<string, unknown>;
      const spec = ctx.spec as Record<string, unknown>;
      expect(spec.prompt as string).toContain("codebase scout");
      expect(spec.prompt as string).toContain("Implement feature X");
    });

    it("returns void and adds no tasks when the coordinator returns no topics", async () => {
      const taskGraph = makeMockTaskGraph();

      // runSession mock returns { mode: "text", text: "" } → no structured
      // output → coordinatorResult is undefined → topics = [] → early return.
      const result = await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { round: 0 },
      );

      expect(result).toBeUndefined();
      // No scout tasks are registered when the coordinator returns no topics.
      expect((taskGraph.addTask as Spy).mock.calls).toHaveLength(0);
    });
  });

  // ─── SessionScheduler wiring ─────────────────────────────────────────────

  describe("SessionScheduler wiring", () => {
    it("constructs a SessionScheduler with the shared graph and phaseId", async () => {
      const taskGraph = makeMockTaskGraph();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { topics, round: 0 },
      );

      const schedulerCalls = mockSessionScheduler.mock.calls as Array<
        [Record<string, unknown>]
      >;
      expect(schedulerCalls.length).toBeGreaterThanOrEqual(1);

      const opts = schedulerCalls[0]![0];
      // Must reference the SHARED graph
      expect(opts.graph).toBe(taskGraph);
      expect(opts.phaseId).toBe("scouting");
      // Must have a gate and profiles
      expect(opts.gate).toBeDefined();
      expect(opts.profiles).toBeDefined();
      // activeSessions must be provided
      expect(opts.activeSessions).toBeDefined();
    });

    it("runnerFactory uses linearRunner of singleSession runners (one per step)", async () => {
      const taskGraph = makeMockTaskGraph();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { topics, round: 0 },
      );

      // singleSession is called once per topic to build the runnerFactory children
      expect(mockSingleSession).toHaveBeenCalledTimes(1);
      const spec = mockSingleSession.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(spec.profile).toBe("scout");
      expect(spec.isReadOnly).toBe(true);
      expect(spec.outputMode).toBe("text");
      expect(spec.role).toBe("scouting");

      // linearRunner wraps the children into a SessionPlanFactory
      expect(mockLinearRunner).toHaveBeenCalledTimes(1);
      const children = mockLinearRunner.mock.calls[0]![0] as unknown[];
      // SCOUTING_STEPS currently has 1 step
      expect(children).toHaveLength(1);
      // Each child is a SessionPlanRunner (result of calling singleSession(spec)())
      expect(typeof children[0]).toBe("object");
      expect(children[0]).toHaveProperty("plan");
      expect(children[0]).toHaveProperty("execute");

      // The runnerFactory (second arg to addTask) should be a callable factory
      const addTaskCalls = (taskGraph.addTask as Spy).mock.calls as Array<
        [Record<string, unknown>, unknown]
      >;
      const runnerFactory = addTaskCalls[0]![1];
      expect(typeof runnerFactory).toBe("function");
      // Calling it yields a SessionPlanRunner (linearRunner mock returns a factory)
      const runner = (runnerFactory as () => unknown)();
      expect(runner).toHaveProperty("plan");
      expect(runner).toHaveProperty("execute");
    });

    it("passes sessionBaseDir derived from workDir and round number", async () => {
      const taskGraph = makeMockTaskGraph();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        "/cwd",
        5,
        "/workdir",
        undefined,
        undefined,
        undefined,
        { topics, round: 2 },
      );

      const schedulerCalls = mockSessionScheduler.mock.calls as Array<
        [Record<string, unknown>]
      >;
      expect(schedulerCalls.length).toBeGreaterThanOrEqual(1);
      expect(schedulerCalls[0]![0].sessionBaseDir as string).toContain(
        "scouting-round-2",
      );
    });
  });

  // ─── Contract: collection is the onPhaseSettled hook's job ────────────────

  it("does NOT call onStatus.onWorkflowData (the onPhaseSettled hook persists scoutingReports)", async () => {
    const taskGraph = makeMockTaskGraph();
    const onStatus = makeStatusCallbacksSpy();
    const topics = [{ topic: "API", rationale: "x", files: ["api.ts"] }];

    await scoutingPhase(
      taskGraph,
      ["/profiles"],
      "Task",
      "/cwd",
      5,
      "/workdir",
      undefined,
      onStatus,
      undefined,
      { topics, round: 0 },
    );

    expect(onStatus.onWorkflowData).not.toHaveBeenCalled();
  });

  it("returns void (reports are collected by the hook, not returned)", async () => {
    const taskGraph = makeMockTaskGraph();
    const topics = [{ topic: "API", rationale: "x", files: ["api.ts"] }];

    const result = await scoutingPhase(
      taskGraph,
      ["/profiles"],
      "Task",
      "/cwd",
      5,
      "/workdir",
      undefined,
      undefined,
      undefined,
      { topics, round: 0 },
    );

    expect(result).toBeUndefined();
  });

  // ─── Global assertion: runSession is never used for scout tasks ───────────

  it("does not call runSession in the follow-up (pre-defined topics) path", async () => {
    const taskGraph = makeMockTaskGraph();
    await scoutingPhase(
      taskGraph,
      ["/profiles"],
      "Task",
      "/cwd",
      5,
      "/workdir",
      undefined,
      undefined,
      undefined,
      {
        topics: [{ topic: "X", rationale: "y", files: ["z"] }],
        round: 0,
      },
    );
    expect(mockRunSession).not.toHaveBeenCalled();
  });
});

// ─── ScoutingReviewPhase ────────────────────────────────────────────────────

describe("scoutingReviewPhase", () => {
  beforeEach(() => {
    mockRunSession.mockClear();
    mockSingleSession.mockClear();
    mockLinearRunner.mockClear();
    mockSessionScheduler.mockClear();
  });

  it("uses runSession for the scouting review", async () => {
    const taskGraph = makeMockTaskGraph();

    await scoutingReviewPhase(
      taskGraph,
      ["/profiles"],
      "Implement feature X",
      [],
      "/cwd",
    );

    expect(mockRunSession).toHaveBeenCalledTimes(1);
    const ctx = mockRunSession.mock.calls[0]![0] as Record<string, unknown>;
    const spec = ctx.spec as Record<string, unknown>;
    expect(spec.profile).toBe("scouting-reviewer");
    expect(spec.runnerRole).toBe("review-scouting");
    expect(spec.isReadOnly).toBe(true);
  });

  it("passes the review prompt to runSession with task and reports context", async () => {
    const taskGraph = makeMockTaskGraph();
    const reports = [{ report: "found-api-issues" }];

    await scoutingReviewPhase(
      taskGraph,
      ["/profiles"],
      "Implement feature X",
      reports,
      "/cwd",
    );

    expect(mockRunSession).toHaveBeenCalledTimes(1);
    const ctx = mockRunSession.mock.calls[0]![0] as Record<string, unknown>;
    const spec = ctx.spec as Record<string, unknown>;
    const prompt = spec.prompt as string;
    expect(prompt).toContain("reviewing scouting reports");
    expect(prompt).toContain("Implement feature X");
    expect(prompt).toContain(JSON.stringify(reports, null, 2));
  });

  it("instructs the reviewer to emit the key files for the planner", async () => {
    const taskGraph = makeMockTaskGraph();

    await scoutingReviewPhase(taskGraph, ["/profiles"], "Task", [], "/cwd");

    expect(mockRunSession).toHaveBeenCalledTimes(1);
    const ctx = mockRunSession.mock.calls[0]![0] as Record<string, unknown>;
    const spec = ctx.spec as Record<string, unknown>;
    const prompt = spec.prompt as string;
    expect(prompt).toContain("`files`");
    expect(prompt).toMatch(/concrete files a planner must/i);
  });

  it("returns a ScoutingReview result", async () => {
    const taskGraph = makeMockTaskGraph();

    const result = (await scoutingReviewPhase(
      taskGraph,
      ["/profiles"],
      "Task",
      [],
      "/cwd",
    )) as ScoutingReview;

    // runSession mock returns text → reviewData undefined → DEFAULT_REVIEW
    expect(result).toBeDefined();
    expect(typeof result.ready).toBe("boolean");
    expect(typeof result.research).toBe("string");
    expect(Array.isArray(result.gaps)).toBe(true);
    expect(Array.isArray(result.files)).toBe(true);
  });

  it("passes apiKeys, onStatus, and signal through to runSession context", async () => {
    const taskGraph = makeMockTaskGraph();
    const onStatus = makeStatusCallbacksSpy();
    const apiKeys = { openai: "sk-test" };
    const abortController = new AbortController();

    await scoutingReviewPhase(
      taskGraph,
      ["/profiles"],
      "Task",
      [],
      "/cwd",
      apiKeys,
      onStatus,
      abortController.signal,
    );

    expect(mockRunSession).toHaveBeenCalledTimes(1);
    const ctx = mockRunSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(ctx.apiKeys).toEqual(apiKeys);
    expect(ctx.signal).toBe(abortController.signal);
  });

  // ─── onDecision callback ──────────────────────────────────────────────────

  describe("onDecision callback", () => {
    it("fires onDecision with proceed_to_planning when ready is true (default review)", async () => {
      const taskGraph = makeMockTaskGraph();
      const onStatus = makeStatusCallbacksSpy();

      await scoutingReviewPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        [],
        "/cwd",
        undefined,
        onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: "scouting-reviewer",
        decision: "proceed_to_planning",
        reasoning: expect.any(String),
      });
    });

    it("fires onDecision with a valid decision value", async () => {
      const taskGraph = makeMockTaskGraph();
      const onStatus = makeStatusCallbacksSpy();

      await scoutingReviewPhase(
        taskGraph,
        ["/profiles"],
        "Task",
        [],
        "/cwd",
        undefined,
        onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
      const onDecisionSpy = onStatus.onDecision as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      };
      const call = onDecisionSpy.mock.calls[0]![0];
      expect(call.agentId).toBe("scouting-reviewer");
      expect(["proceed_to_planning", "more_scouting_needed"]).toContain(
        call.decision as string,
      );
      expect(typeof call.reasoning).toBe("string");
    });

    it("does not throw when onStatus is undefined", async () => {
      const taskGraph = makeMockTaskGraph();

      await expect(
        scoutingReviewPhase(taskGraph, ["/profiles"], "Task", [], "/cwd"),
      ).resolves.toBeDefined();
    });
  });
});
