// ─── Scouting Phase Tests ────────────────────────────────────────────────────
//
// Tests for the rewritten scouting.ts that uses runStepTask instead of
// manual createHarness / spawnAgent / promptForStructured sequences.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks, WorkflowStatusTracker } from '@harms-haus/engin';

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

  getAllTasks() {
    return Array.from(this.tasks.values());
  }
}

class MockLanePool {
  constructor(_opts: Record<string, unknown>) {}
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

mock.module('@harms-haus/engin', () => ({
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  runStepTask: mockRunStepTask,
  // Helpers used by ./helpers (transitively loaded)
  loadProfilesFromDirs: async () => new Map(),
  forwardAgentStatus: (cb: unknown) => cb,
  // Type stubs for module resolution
  WorkflowStatusTracker: class {},
  StatusCallbacks: {},
  StepDefinition: {},
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
  });

  // ─── Pre-defined topics path (follow-up round) ────────────────────────────

  describe('when topics are pre-defined (follow-up round)', () => {
    it('skips the scout-coordinator and uses the provided topics directly', async () => {
      const tracker = makeMockTracker();
      const topics = [
        { topic: 'API Design', rationale: 'Need to understand API endpoints', files: ['src/api/'] },
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
      expect(result).toBeInstanceOf(Array);
    });

    it('delegates to coordinator when topics array is empty (treated as no pre-defined topics)', async () => {
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
        { topics: [], round: 0 },
      );

      // Empty topics array is not > 0 length, so coordinator is called
      expect(mockRunStepTask).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it('preserves existing reports when no new results from LanePool', async () => {
      const tracker = makeMockTracker();
      const existing = [{ report: 'first' }];
      const topics = [{ topic: 'API', rationale: 'Check API', files: ['api.ts'] }];

      // With a topic but the LanePool returns nothing (no completed tasks),
      // the result should still include existingReports.
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
        { topics, existingReports: existing, round: 0 },
      );

      expect(result).toEqual(existing);
    });
  });

  // ─── Scout-coordinator path (first round) ─────────────────────────────────

  describe('when no topics are provided (first round)', () => {
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

    it('appends structured output to audit log from coordinator', async () => {
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

      expect(tracker.auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'structured_output',
          agentId: 'scout-coordinator',
          output: mockTopics,
        }),
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

    it('returns empty array when coordinator returns no topics', async () => {
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

      expect(result).toEqual([]);
    });
  });

  // ─── WorkflowData ─────────────────────────────────────────────────────────

  it('calls setWorkflowData with the accumulated scoutingReports', async () => {
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
      { round: 0 },
    );

    expect(tracker.setWorkflowData).toHaveBeenCalledWith({
      scoutingReports: [],
    });
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
    it('appends a decision event to the audit log', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({
        ready: false,
        research: 'Need more data',
        gaps: [{ topic: 'API', rationale: 'Explain', files: ['api.ts'] }],
      });

      await scoutingReviewPhase(tracker, ['/profiles'], 'Task', [], '/cwd');

      expect(tracker.auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decision',
          agentId: 'scouting-reviewer',
          decision: 'more_scouting_needed',
          reasoning: 'Need more data',
        }),
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
