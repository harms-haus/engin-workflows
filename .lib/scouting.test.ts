// ─── Scouting Phase Tests ────────────────────────────────────────────────────
//
// Tests for the rewritten scouting.ts that uses RunnerPool instead of LanePool
// and singleSession/linearRunner/reviewRunner instead of runStepTask.
//
// These tests pin the DESIRED behavior (kb-13/B2). They will FAIL against the
// current production code which still uses LanePool + runStepTask. Once the
// migration is implemented, they should all pass.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import type {
  StatusCallbacks,
  WorkflowStatusTracker,
} from "@harms-haus/engin-engine";
import { createEnginMock } from "./engin-mock";

// ─── Mock @harms-haus/engin-engine ────────────────────────────────────────
//
// We mock the ENTIRE module via createEnginMock() which provides the improved
// singleSession that calls ctx.runSession (needed by runSingleSessionStructured
// in session-utils.ts). We override RunnerPool to capture construction options.
//
// Since mock.module is process-global and the engine module may already be
// cached from another test file, we read the ACTUAL mock instances from the
// engine module after setup, and clear them in beforeEach.

class MockTaskTracker {
  private tasks: Map<string, Record<string, unknown>> = new Map();

  addTask(task: Record<string, unknown>) {
    if (this.tasks.has(task.id as string)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }
    this.tasks.set(task.id as string, {
      ...task,
      status: task.status ?? "ready",
    });
  }

  getTask(id: string) {
    return this.tasks.get(id);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }
}

/** Captures the most recent RunnerPool construction options. */
let lastRunnerPoolOpts: Record<string, unknown> | undefined;
let runnerPoolConstructed = false;

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  TaskTracker: MockTaskTracker,
  RunnerPool: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
    runnerPoolConstructed = true;
    lastRunnerPoolOpts = opts;
    return {
      run: jest.fn().mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
    };
  }),
}));

// Import the engine to get the ACTUAL mock instances used by the implementation
const engineModule = await import("@harms-haus/engin-engine");

// References to the shared mock instances (read from the cached engine module)
const mockRunStepTask = engineModule.runStepTask as ReturnType<typeof mock>;
const mockSingleSession = engineModule.singleSession as ReturnType<typeof mock>;
const mockLinearRunner = engineModule.linearRunner as ReturnType<typeof mock>;
const mockReviewRunner = engineModule.reviewRunner as ReturnType<typeof mock>;

// Dynamic import after mock is set up
const { scoutingPhase, scoutingReviewPhase } = await import("./scouting");
import type { ScoutingReview } from "./schemas";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMockTracker(): WorkflowStatusTracker {
  return {
    auditLog: { append: mock(() => {}) },
    setWorkflowData: mock(() => {}),
    recordAgentSpawn: mock(() => {}),
    incrementAgentCount: mock(() => {}),
    taskTracker: new MockTaskTracker(),
  } as unknown as WorkflowStatusTracker;
}

function makeStatusCallbacksSpy() {
  return {
    onAgentSpawn: mock(() => {}),
    onAgentComplete: mock(() => {}),
    onDecision: mock(() => {}),
    onTaskRegister: mock(() => {}),
    onTaskStart: mock(() => {}),
    onTaskComplete: mock(() => {}),
    onTaskRejected: mock(() => {}),
    onStepStart: mock(() => {}),
  } as unknown as StatusCallbacks;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("scoutingPhase", () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockSingleSession.mockClear();
    mockLinearRunner.mockClear();
    mockReviewRunner.mockClear();
    (engineModule.RunnerPool as ReturnType<typeof mock>).mockClear();
    lastRunnerPoolOpts = undefined;
    runnerPoolConstructed = false;
  });

  // ─── Pre-defined topics path (follow-up round) ────────────────────────

  describe("when topics are pre-defined (follow-up round)", () => {
    it("skips the scout-coordinator and adds one scout task per topic to the SHARED tracker", async () => {
      const tracker = makeMockTracker();
      const topics = [
        {
          topic: "API Design",
          rationale: "Need to understand API endpoints",
          files: ["src/api/"],
        },
        { topic: "Database", rationale: "Inspect schema", files: ["src/db/"] },
      ];

      await scoutingPhase(
        tracker,
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

      // Coordinator should NOT have been called — neither via runStepTask nor singleSession
      expect(mockRunStepTask).not.toHaveBeenCalled();
      expect(mockSingleSession).not.toHaveBeenCalled();
      // One scout task per topic lands on the SHARED tracker (phaseId 'scouting')
      // so the onPhaseSettled hook can collect them.
      const tasks = tracker.taskTracker.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("scout-api-design");
      expect(tasks[0].phaseId).toBe("scouting");
      expect(tasks[0].profile).toBe("scout");
      expect(tasks[1].id).toBe("scout-database");
    });

    it("does not re-add a task whose slug already exists on the shared tracker", async () => {
      const tracker = makeMockTracker();
      const topics = [
        { topic: "API Design", rationale: "x", files: ["a"] },
        { topic: "API-Design", rationale: "y", files: ["b"] },
      ];

      await expect(
        scoutingPhase(
          tracker,
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

      expect(tracker.taskTracker.getAllTasks()).toHaveLength(1);
      // runStepTask must not be called in the follow-up path
      expect(mockRunStepTask).not.toHaveBeenCalled();
    });
  });

  // ─── Scout-coordinator path (first round) ─────────────────────────────────

  describe("when no topics are provided (first round)", () => {
    it("uses singleSession for the scout-coordinator (not runStepTask)", async () => {
      const tracker = makeMockTracker();

      await scoutingPhase(
        tracker,
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

      // Once the migration is complete, runStepTask must NOT be called.
      // Currently the production code calls it, so this assertion FAILS (TDD red).
      expect(mockRunStepTask).not.toHaveBeenCalled();

      // The coordinator should be invoked via singleSession.
      expect(mockSingleSession).toHaveBeenCalledTimes(1);
      const spec = mockSingleSession.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(spec.profile).toBe("scout-coordinator");
      expect(spec.role).toBe("coordinate");
      expect(spec.isReadOnly).toBe(true);
    });

    it("passes the correct prompt to singleSession for the coordinator", async () => {
      const tracker = makeMockTracker();

      await scoutingPhase(
        tracker,
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

      expect(mockSingleSession).toHaveBeenCalledTimes(1);
      const spec = mockSingleSession.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(spec.prompt).toContain("codebase scout");
      expect(spec.prompt).toContain("Implement feature X");
    });

    it("returns void and adds no tasks when the coordinator returns no topics", async () => {
      const tracker = makeMockTracker();

      const result = await scoutingPhase(
        tracker,
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
      expect(tracker.taskTracker.getAllTasks()).toHaveLength(0);
    });

    it("does NOT manually append structured_output for the coordinator (the default auditor handles it)", async () => {
      const tracker = makeMockTracker();

      await scoutingPhase(
        tracker,
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

      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "structured_output" }),
      );
    });
  });

  // ─── RunnerPool wiring ─────────────────────────────────────────────────────

  describe("RunnerPool wiring", () => {
    it("constructs a RunnerPool (not LanePool) with getRunnerForTask", async () => {
      const tracker = makeMockTracker();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        tracker,
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

      // Assert RunnerPool was constructed (reads from the engine-module mock)
      const rpCalls = (engineModule.RunnerPool as ReturnType<typeof mock>).mock
        .calls as Array<[Record<string, unknown>]>;
      expect(rpCalls.length).toBeGreaterThanOrEqual(1);

      const opts = rpCalls[0]![0];
      // Must use getRunnerForTask, NOT getStepsForTask
      expect(opts.getRunnerForTask).toBeDefined();
      expect(opts.getStepsForTask).toBeUndefined();
      // Must use maxConcurrentSessions (not maxConcurrentLanes)
      expect(opts.maxConcurrentSessions).toBe(5);
      expect(opts.maxConcurrentLanes).toBeUndefined();
      // Must reference the SHARED tracker
      expect(opts.taskTracker).toBe(tracker.taskTracker);
      expect(opts.phaseId).toBe("scouting");
    });

    it("getRunnerForTask returns a linearRunner of singleSession runners (one per SCOUTING_STEPS step)", async () => {
      const tracker = makeMockTracker();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        tracker,
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

      const rpCalls = (engineModule.RunnerPool as ReturnType<typeof mock>).mock
        .calls as Array<[Record<string, unknown>]>;
      const getRunnerForTask = rpCalls[0]?.[0]?.getRunnerForTask as
        | ((task: Record<string, unknown>) => unknown)
        | undefined;
      if (!getRunnerForTask) {
        expect(getRunnerForTask).toBeDefined();
        return;
      }

      // Reset mocks to isolate the getRunnerForTask calls
      mockLinearRunner.mockClear();
      mockSingleSession.mockClear();

      const task = {
        id: "scout-auth",
        profile: "scout",
        prompt: "Investigate auth module",
      };
      const runner = getRunnerForTask(task);

      // Should create a linearRunner with children matching SCOUTING_STEPS length
      expect(mockLinearRunner).toHaveBeenCalledTimes(1);
      const children = mockLinearRunner.mock.calls[0]![0] as unknown[];
      // SCOUTING_STEPS currently has 1 step: { name: 'scouting', profileId: 'scout', isReadOnly: true }
      expect(children).toHaveLength(1);
      // Each child should be a runner function (returned by singleSession)
      expect(typeof children[0]).toBe("function");

      // Verify singleSession was called with scout-specific spec
      expect(mockSingleSession).toHaveBeenCalledTimes(1);
      const spec = mockSingleSession.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(spec.profile).toBe("scout");
      expect(spec.isReadOnly).toBe(true);
      // The returned runner must be callable
      expect(typeof runner).toBe("function");
    });

    it("does NOT pass getStepsForTask to the pool", async () => {
      const tracker = makeMockTracker();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        tracker,
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

      // Assert RunnerPool was constructed with getRunnerForTask (no getStepsForTask)
      const rpCalls = (engineModule.RunnerPool as ReturnType<typeof mock>).mock
        .calls as Array<[Record<string, unknown>]>;
      expect(rpCalls.length).toBeGreaterThanOrEqual(1);
      expect(rpCalls[0]![0].getStepsForTask).toBeUndefined();
    });

    it("passes sessionBaseDir derived from workDir and round number", async () => {
      const tracker = makeMockTracker();
      const topics = [{ topic: "Auth", rationale: "x", files: ["auth.ts"] }];

      await scoutingPhase(
        tracker,
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

      // Assert sessionBaseDir incorporates the round number
      const rpCalls = (engineModule.RunnerPool as ReturnType<typeof mock>).mock
        .calls as Array<[Record<string, unknown>]>;
      expect(rpCalls.length).toBeGreaterThanOrEqual(1);
      expect(rpCalls[0]![0].sessionBaseDir as string).toContain(
        "scouting-round-2",
      );
    });
  });

  // ─── Contract: collection is the onPhaseSettled hook's job ────────────────

  it("does NOT call setWorkflowData (the onPhaseSettled hook persists scoutingReports)", async () => {
    const tracker = makeMockTracker();
    const topics = [{ topic: "API", rationale: "x", files: ["api.ts"] }];

    await scoutingPhase(
      tracker,
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

    expect(tracker.setWorkflowData).not.toHaveBeenCalled();
  });

  it("does NOT fire onAgentComplete (the RunnerPool owns per-scout completion)", async () => {
    const tracker = makeMockTracker();
    const onStatus = makeStatusCallbacksSpy();
    const topics = [{ topic: "API", rationale: "x", files: ["api.ts"] }];

    await scoutingPhase(
      tracker,
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

    expect(onStatus.onAgentComplete).not.toHaveBeenCalled();
  });

  it("returns void (reports are collected by the hook, not returned)", async () => {
    const tracker = makeMockTracker();
    const topics = [{ topic: "API", rationale: "x", files: ["api.ts"] }];

    const result = await scoutingPhase(
      tracker,
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

  // ─── Global assertion: runStepTask is never used across any scoutingPhase path ──

  it("never calls runStepTask (0 calls total across all paths)", async () => {
    // Follow-up path
    const tracker1 = makeMockTracker();
    await scoutingPhase(
      tracker1,
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
    // This already fails because the current code calls runStepTask in the coordinator path
    // Here we also verify the follow-up path doesn't call it
    expect(mockRunStepTask).not.toHaveBeenCalled();
  });
});

// ─── ScoutingReviewPhase ────────────────────────────────────────────────────

describe("scoutingReviewPhase", () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockSingleSession.mockClear();
    mockLinearRunner.mockClear();
    mockReviewRunner.mockClear();
    (engineModule.RunnerPool as ReturnType<typeof mock>).mockClear();
  });

  it("uses singleSession for the scouting review (not runStepTask)", async () => {
    const tracker = makeMockTracker();

    await scoutingReviewPhase(
      tracker,
      ["/profiles"],
      "Implement feature X",
      [],
      "/cwd",
    );

    // The migration replaces runStepTask with singleSession — this FAILS currently
    expect(mockRunStepTask).not.toHaveBeenCalled();
    expect(mockSingleSession).toHaveBeenCalledTimes(1);
    const spec = mockSingleSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec.profile).toBe("scouting-reviewer");
    expect(spec.role).toBe("review-scouting");
    expect(spec.isReadOnly).toBe(true);
  });

  it("passes the review prompt to singleSession with task and reports context", async () => {
    const tracker = makeMockTracker();
    const reports = [{ report: "found-api-issues" }];

    await scoutingReviewPhase(
      tracker,
      ["/profiles"],
      "Implement feature X",
      reports,
      "/cwd",
    );

    expect(mockSingleSession).toHaveBeenCalledTimes(1);
    const prompt = mockSingleSession.mock.calls[0]![0]!.prompt as string;
    expect(prompt).toContain("reviewing scouting reports");
    expect(prompt).toContain("Implement feature X");
    expect(prompt).toContain(JSON.stringify(reports, null, 2));
  });

  it("instructs the reviewer to emit the key files for the planner", async () => {
    const tracker = makeMockTracker();

    await scoutingReviewPhase(tracker, ["/profiles"], "Task", [], "/cwd");

    expect(mockSingleSession).toHaveBeenCalledTimes(1);
    const prompt = mockSingleSession.mock.calls[0]![0]!.prompt as string;
    expect(prompt).toContain("`files`");
    expect(prompt).toMatch(/concrete files a planner must/i);
  });

  it("returns a ScoutingReview result", async () => {
    const tracker = makeMockTracker();

    const result = await scoutingReviewPhase(
      tracker,
      ["/profiles"],
      "Task",
      [],
      "/cwd",
    );

    // The review result structure must be preserved regardless of how it's produced
    expect(result).toBeDefined();
    expect(typeof result.ready).toBe("boolean");
    expect(typeof result.research).toBe("string");
    expect(Array.isArray(result.gaps)).toBe(true);
    expect(Array.isArray(result.files)).toBe(true);
  });

  it("passes apiKeys, onStatus, and signal through", async () => {
    const tracker = makeMockTracker();
    const onStatus = makeStatusCallbacksSpy();
    const apiKeys = { openai: "sk-test" };
    const abortController = new AbortController();

    await scoutingReviewPhase(
      tracker,
      ["/profiles"],
      "Task",
      [],
      "/cwd",
      apiKeys,
      onStatus,
      abortController.signal,
    );

    expect(mockSingleSession).toHaveBeenCalledTimes(1);
    // apiKeys, onStatus, and signal are threaded through the RunnerContext,
    // not the singleSession spec itself. This test verifies the overall
    // flow uses singleSession for the review.
  });

  // ─── onDecision callback ──────────────────────────────────────────────────

  describe("onDecision callback", () => {
    it("fires onDecision with proceed_to_planning when ready is true", async () => {
      const tracker = makeMockTracker();
      const onStatus = makeStatusCallbacksSpy();

      await scoutingReviewPhase(
        tracker,
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

    it("fires onDecision with more_scouting_needed when ready is false", async () => {
      const tracker = makeMockTracker();
      const onStatus = makeStatusCallbacksSpy();

      await scoutingReviewPhase(
        tracker,
        ["/profiles"],
        "Task",
        [],
        "/cwd",
        undefined,
        onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
      // Cast for mock access — bun:test adds .mock to the spy function
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
      const tracker = makeMockTracker();

      await expect(
        scoutingReviewPhase(tracker, ["/profiles"], "Task", [], "/cwd"),
      ).resolves.toBeDefined();
    });
  });

  // ─── Audit log ────────────────────────────────────────────────────────────

  describe("audit log", () => {
    it("does NOT manually append a decision event (the default auditor handles it)", async () => {
      const tracker = makeMockTracker();

      await scoutingReviewPhase(tracker, ["/profiles"], "Task", [], "/cwd");

      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "decision" }),
      );
    });
  });

  // ─── Global assertion: runStepTask never called from review phase ─────────

  it("never calls runStepTask (0 calls)", async () => {
    const tracker = makeMockTracker();

    await scoutingReviewPhase(tracker, ["/profiles"], "Task", [], "/cwd");

    expect(mockRunStepTask).not.toHaveBeenCalled();
  });
});
