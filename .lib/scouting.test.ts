// ─── Scouting Phase Tests ────────────────────────────────────────────────────
//
// Tests for the rewritten scouting.ts that uses runStepTask instead of
// manual createHarness / spawnAgent / promptForStructured sequences.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks, WorkflowStatusTracker } from '@harms-haus/engin-engine';
import { createEnginMock } from './engin-mock';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
//
// Mock LanePool and runStepTask so tests run without actual agent harnesses.
// We also provide stubs for types and helpers that helpers.ts imports.

class MockTaskTracker {
  private tasks: Map<string, Record<string, unknown>> = new Map();

  addTask(task: Record<string, unknown>) {
    if (this.tasks.has(task.id as string)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }
    this.tasks.set(task.id as string, { ...task, status: task.status ?? 'ready' });
  }

  getTask(id: string) {
    return this.tasks.get(id);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }
}

/** Captures the options handed to the most recent `new LanePool(...)` so tests
 *  can assert on the wiring (e.g. the shared taskTracker). */
let lastLanePoolOpts: Record<string, unknown> | undefined;

class MockLanePool {
  constructor(opts: Record<string, unknown>) {
    lastLanePoolOpts = opts;
  }
  async run() {}
}

const mockRunStepTask = mock<(opts: Record<string, unknown>) => Promise<unknown>>();
mockRunStepTask.mockImplementation(async () => ({
  topics: [],
  ready: true,
  research: 'Mock research',
  gaps: [],
  tasks: [],
  strategy: '',
  feedback: 'Mock feedback',
  suggestions: [],
}));

mock.module('@harms-haus/engin-engine', () => ({
  ...createEnginMock(),
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  runStepTask: mockRunStepTask,
}));

// Dynamic import after mock is set up
const { scoutingPhase, scoutingReviewPhase } = await import('./scouting');
import type { ScoutingReview, ScoutingTopics } from './schemas';

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

describe('scoutingPhase', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    lastLanePoolOpts = undefined;
  });

  // ─── Pre-defined topics path (follow-up round) ────────────────────────

  describe('when topics are pre-defined (follow-up round)', () => {
    it('skips the scout-coordinator and adds one scout task per topic to the SHARED tracker', async () => {
      const tracker = makeMockTracker();
      const topics = [
        { topic: 'API Design', rationale: 'Need to understand API endpoints', files: ['src/api/'] },
        { topic: 'Database', rationale: 'Inspect schema', files: ['src/db/'] },
      ];

      const result = await scoutingPhase(
        tracker,
        ['/profiles'],
        'Implement feature X',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        undefined,
        { topics, round: 1 },
      );

      // Coordinator should NOT have been called
      expect(mockRunStepTask).not.toHaveBeenCalled();
      // scoutingPhase no longer returns reports — collection is the hook's job
      expect(result).toBeUndefined();
      // One scout task per topic lands on the SHARED tracker (phaseId 'scouting')
      // so the onPhaseSettled hook can collect them.
      const tasks = tracker.taskTracker.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe('scout-api-design');
      expect(tasks[0].phaseId).toBe('scouting');
      expect(tasks[0].profile).toBe('scout');
      expect(tasks[1].id).toBe('scout-database');
    });

    it('does not re-add a task whose slug already exists on the shared tracker', async () => {
      const tracker = makeMockTracker();
      // Two topics that slug down to the same id — the shared-tracker guard
      // must skip the duplicate rather than throw (a follow-up round can
      // legitimately re-encounter a prior topic slug).
      const topics = [
        { topic: 'API Design', rationale: 'x', files: ['a'] },
        { topic: 'API-Design', rationale: 'y', files: ['b'] },
      ];

      await expect(
        scoutingPhase(
          tracker,
          ['/profiles'],
          'Task',
          '/cwd',
          5,
          '/workdir',
          undefined,
          undefined,
          undefined,
          { topics, round: 0 },
        ),
      ).resolves.toBeUndefined();

      expect(tracker.taskTracker.getAllTasks()).toHaveLength(1);
    });
  });

  // ─── Scout-coordinator path (first round) ─────────────────────────────────

  describe('when no topics are provided (first round)', () => {
    it('delegates to the scout-coordinator when topics array is empty (treated as no pre-defined topics)', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ topics: [] });

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        undefined,
        { topics: [], round: 0 },
      );

      // Empty topics array is not > 0 length, so the coordinator is called.
      expect(mockRunStepTask).toHaveBeenCalledTimes(1);
      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(callOpts.taskId).toBe('scout-coordinator');
    });

    it('calls runStepTask for the scout-coordinator with correct options', async () => {
      const tracker = makeMockTracker();
      const mockTopics: ScoutingTopics = {
        topics: [{ topic: 'API', rationale: 'Need API review', files: ['api.ts'] }],
      };
      mockRunStepTask.mockResolvedValueOnce(mockTopics);

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Implement feature X',
        '/cwd',
        5,
        '/workdir',
        { openai: 'sk-test' },
        undefined,
        undefined,
        { round: 0 },
      );

      expect(mockRunStepTask).toHaveBeenCalledTimes(1);
      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(callOpts.taskId).toBe('scout-coordinator');
      expect(callOpts.phaseId).toBe('scouting');
      expect(callOpts.stepName).toBe('coordinate');
      expect(callOpts.profileId).toBe('scout-coordinator');
      expect(callOpts.isReadOnly).toBe(true);
      expect(callOpts.prompt).toContain('codebase scout');
      expect(callOpts.prompt).toContain('Implement feature X');
    });

    it('passes the signal through to runStepTask', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ topics: [] });
      const abortController = new AbortController();

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        abortController.signal,
        { round: 0 },
      );

      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(callOpts.signal).toBe(abortController.signal);
    });

    it('does NOT manually append structured_output for the coordinator (the default auditor handles it)', async () => {
      const tracker = makeMockTracker();
      const mockTopics: ScoutingTopics = {
        topics: [{ topic: 'Auth', rationale: 'Auth logic', files: ['auth.ts'] }],
      };
      mockRunStepTask.mockResolvedValueOnce(mockTopics);

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        undefined,
        { round: 0 },
      );

      // The audit migration deleted the manual
      // `auditLog.append(structuredOutputEvent(…))`; structured_output events
      // now land via the engine's default auditor (fired through the threaded
      // hookRegistry). With the engine mocked here no auditor fires, so append
      // must NOT receive a structured_output event.
      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'structured_output' }),
      );
    });

    it('passes apiKeys and onStatus to runStepTask', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ topics: [] });
      const apiKeys = { openai: 'sk-test' };
      const onStatus = makeStatusCallbacksSpy();

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        apiKeys,
        onStatus,
        undefined,
        { round: 0 },
      );

      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(callOpts.apiKeys).toEqual(apiKeys);
      expect(callOpts.onStatus).toBe(onStatus);
    });

    it('returns void and adds no tasks when the coordinator returns no topics', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ topics: [] });

      const result = await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        undefined,
        { round: 0 },
      );

      expect(result).toBeUndefined();
      expect(tracker.taskTracker.getAllTasks()).toHaveLength(0);
    });
  });

  // ─── LanePool wiring (shared tracker) ─────────────────────────────────────

  describe('LanePool wiring', () => {
    it('constructs the LanePool against the SHARED tracker', async () => {
      const tracker = makeMockTracker();
      const topics = [{ topic: 'Auth', rationale: 'x', files: ['auth.ts'] }];

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        undefined,
        { topics, round: 0 },
      );

      expect(lastLanePoolOpts).toBeDefined();
      // The LanePool must run against the SAME tracker the phase writes to, so
      // scout completions settle on the shared surface the onPhaseSettled hook
      // reads from (the latent bug this refactor fixes).
      expect(lastLanePoolOpts!.taskTracker).toBe(tracker.taskTracker);
      expect(lastLanePoolOpts!.phaseId).toBe('scouting');
    });

    it('threads the scouting step via getStepsForTask', async () => {
      const tracker = makeMockTracker();
      const topics = [{ topic: 'Auth', rationale: 'x', files: ['auth.ts'] }];

      await scoutingPhase(
        tracker,
        ['/profiles'],
        'Task',
        '/cwd',
        5,
        '/workdir',
        undefined,
        undefined,
        undefined,
        { topics, round: 0 },
      );

      const getStepsForTask = lastLanePoolOpts!.getStepsForTask as () => unknown[];
      const steps = getStepsForTask();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ profileId: 'scout', isReadOnly: true });
    });
  });

  // ─── Contract: collection is the onPhaseSettled hook's job ────────────────

  it('does NOT call setWorkflowData (the onPhaseSettled hook persists scoutingReports)', async () => {
    const tracker = makeMockTracker();
    const topics = [{ topic: 'API', rationale: 'x', files: ['api.ts'] }];

    await scoutingPhase(
      tracker,
      ['/profiles'],
      'Task',
      '/cwd',
      5,
      '/workdir',
      undefined,
      undefined,
      undefined,
      { topics, round: 0 },
    );

    // scoutingPhase no longer persists reports itself — that moved to the
    // onPhaseSettled hook (tested in spir.test.ts).
    expect(tracker.setWorkflowData).not.toHaveBeenCalled();
  });

  it('does NOT fire onAgentComplete (the LanePool owns per-scout completion)', async () => {
    const tracker = makeMockTracker();
    const onStatus = makeStatusCallbacksSpy();
    const topics = [{ topic: 'API', rationale: 'x', files: ['api.ts'] }];

    await scoutingPhase(
      tracker,
      ['/profiles'],
      'Task',
      '/cwd',
      5,
      '/workdir',
      undefined,
      onStatus,
      undefined,
      { topics, round: 0 },
    );

    // The LanePool fires onAgentComplete for each scout step via its own
    // runStep → handle.complete() path, so scoutingPhase must not fire a
    // second (less-complete) one itself.
    expect(onStatus.onAgentComplete).not.toHaveBeenCalled();
  });

  it('returns void (reports are collected by the hook, not returned)', async () => {
    const tracker = makeMockTracker();
    const topics = [{ topic: 'API', rationale: 'x', files: ['api.ts'] }];

    const result = await scoutingPhase(
      tracker,
      ['/profiles'],
      'Task',
      '/cwd',
      5,
      '/workdir',
      undefined,
      undefined,
      undefined,
      { topics, round: 0 },
    );

    expect(result).toBeUndefined();
  });
});

// ─── ScoutingReviewPhase ────────────────────────────────────────────────────

describe('scoutingReviewPhase', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  it('calls runStepTask with correct options', async () => {
    const tracker = makeMockTracker();
    const reports = [{ report: 'scout-result' }];
    const reviewResult: ScoutingReview = { ready: true, research: 'All areas covered', files: ['src/api.ts'], gaps: [] };
    mockRunStepTask.mockResolvedValueOnce(reviewResult);

    const result = await scoutingReviewPhase(
      tracker, ['/profiles'], 'Implement feature X', reports, '/cwd',
    );

    expect(result).toBe(reviewResult);
    expect(mockRunStepTask).toHaveBeenCalledTimes(1);

    const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(callOpts.taskId).toBe('scouting-reviewer');
    expect(callOpts.phaseId).toBe('scouting');
    expect(callOpts.stepName).toBe('review-scouting');
    expect(callOpts.profileId).toBe('scouting-reviewer');
    expect(callOpts.isReadOnly).toBe(true);
    expect(callOpts.prompt).toContain('reviewing scouting reports');
    // The task prompt MUST be included so the reviewer can judge relevance.
    expect(callOpts.prompt).toContain('Implement feature X');
    expect(callOpts.prompt).toContain(JSON.stringify(reports, null, 2));
  });

  it('instructs the reviewer to emit the key files for the planner', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce({ ready: true, research: '', gaps: [], files: [] });

    await scoutingReviewPhase(tracker, ['/profiles'], 'Task', [], '/cwd');

    const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
    expect(prompt).toContain('`files`');
    expect(prompt).toMatch(/concrete files a planner must/i);
  });

  it('passes apiKeys, onStatus, and signal through to runStepTask', async () => {
    const tracker = makeMockTracker();
    const onStatus = makeStatusCallbacksSpy();
    const apiKeys = { openai: 'sk-test' };
    const abortController = new AbortController();
    mockRunStepTask.mockResolvedValueOnce({ ready: true, research: '', gaps: [] });

    await scoutingReviewPhase(
      tracker, ['/profiles'], 'Task', [], '/cwd',
      apiKeys, onStatus, abortController.signal,
    );

    const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(callOpts.apiKeys).toBe(apiKeys);
    expect(callOpts.onStatus).toBe(onStatus);
    expect(callOpts.signal).toBe(abortController.signal);
  });

  describe('onDecision callback', () => {
    it('fires onDecision with proceed_to_planning when ready is true', async () => {
      const tracker = makeMockTracker();
      const onStatus = makeStatusCallbacksSpy();
      mockRunStepTask.mockResolvedValueOnce({ ready: true, research: 'All good', gaps: [] });

      await scoutingReviewPhase(
        tracker, ['/profiles'], 'Task', [], '/cwd',
        undefined, onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'scouting-reviewer',
        decision: 'proceed_to_planning',
        reasoning: 'All good',
      });
    });

    it('fires onDecision with more_scouting_needed when ready is false', async () => {
      const tracker = makeMockTracker();
      const onStatus = makeStatusCallbacksSpy();
      mockRunStepTask.mockResolvedValueOnce({
        ready: false,
        research: 'Missing API details',
        gaps: [{ topic: 'API', rationale: 'Need more info', files: ['api.ts'] }],
      });

      await scoutingReviewPhase(
        tracker, ['/profiles'], 'Task', [], '/cwd',
        undefined, onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'scouting-reviewer',
        decision: 'more_scouting_needed',
        reasoning: 'Missing API details',
      });
    });

    it('does not throw when onStatus is undefined', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ ready: true, research: 'OK', gaps: [] });

      await expect(
        scoutingReviewPhase(tracker, ['/profiles'], 'Task', [], '/cwd'),
      ).resolves.toBeDefined();
    });
  });

  describe('audit log', () => {
    it('does NOT manually append a decision event (the default auditor handles it)', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({
        ready: false,
        research: 'Need more data',
        gaps: [{ topic: 'API', rationale: 'Explain', files: ['api.ts'] }],
      });

      await scoutingReviewPhase(tracker, ['/profiles'], 'Task', [], '/cwd');

      // The audit migration deleted the manual
      // `auditLog.append(decisionEvent(…))`; the scouting-reviewer decision
      // now lands via the engine's default auditor. With the engine mocked
      // here, append must NOT receive a decision event. (The onStatus.onDecision
      // store callback for the TUI is still asserted separately above.)
      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decision' }),
      );
    });
  });

  it('returns the review result from runStepTask', async () => {
    const tracker = makeMockTracker();
    const reviewResult: ScoutingReview = { ready: true, research: 'Comprehensive', files: [], gaps: [] };
    mockRunStepTask.mockResolvedValueOnce(reviewResult);

    const result = await scoutingReviewPhase(tracker, ['/profiles'], 'Task', [], '/cwd');

    expect(result).toBe(reviewResult);
  });
});
