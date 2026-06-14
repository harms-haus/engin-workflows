// ─── Planning Phase Tests ────────────────────────────────────────────────────
//
// Tests for the rewritten planning.ts that uses runStepTask instead of
// manual createHarness / spawnAgent / promptForStructured sequences.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StatusCallbacks, WorkflowStatusTracker } from '@harms-haus/engin';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
//
// IMPORTANT: Bun's mock.module persists across test files in the same process.
// We provide comprehensive stubs for EVERY export that ANY file importing
// @harms-haus/engin might reference, so the mock works regardless of load order.

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
  tasks: [],
  strategy: '',
  ready: true,
  research: 'Mock research',
  gaps: [],
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
const { planningPhase, planReviewPhase } = await import('./planning');
import type { Plan, PlanReview } from './schemas';

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

describe('planningPhase', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  // ─── Basic execution ──────────────────────────────────────────────────────

  it('calls runStepTask with correct default options', async () => {
    const tracker = makeMockTracker();
    const planResult: Plan = {
      tasks: [{
        id: 'task-1', title: 'Do thing', prompt: 'Implement',
        profile: 'implementer', files: ['src/main.ts'], is_code: true, dependencies: [],
      }],
      strategy: 'Step by step',
    };
    mockRunStepTask.mockResolvedValueOnce(planResult);

    const result = await planningPhase(
      tracker, ['/profiles'], 'Research results...', 'Implement feature X', '/cwd',
    );

    expect(result).toBe(planResult);
    expect(mockRunStepTask).toHaveBeenCalledTimes(1);

    const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(callOpts.taskId).toBe('planner');
    expect(callOpts.phaseId).toBe('planning');
    expect(callOpts.stepName).toBe('plan');
    expect(callOpts.profileId).toBe('planner');
    expect(callOpts.isReadOnly).toBe(true);
    expect(callOpts.prompt).toContain('planning agent');
    expect(callOpts.prompt).toContain('Implement feature X');
    expect(callOpts.prompt).toContain('Research results...');
  });

  it('passes apiKeys, onStatus, and signal through to runStepTask', async () => {
    const tracker = makeMockTracker();
    const apiKeys = { openai: 'sk-test' };
    const onStatus = makeStatusCallbacksSpy();
    const abortController = new AbortController();
    mockRunStepTask.mockResolvedValueOnce({ tasks: [], strategy: '' });

    await planningPhase(
      tracker, ['/profiles'], 'Research', 'Task', '/cwd',
      undefined, undefined, apiKeys, onStatus, abortController.signal,
    );

    const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(callOpts.apiKeys).toBe(apiKeys);
    expect(callOpts.onStatus).toBe(onStatus);
    expect(callOpts.signal).toBe(abortController.signal);
  });

  // ─── Plan review feedback ─────────────────────────────────────────────────

  describe('with plan review feedback', () => {
    it('includes feedback in the prompt when provided', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ tasks: [], strategy: '' });

      await planningPhase(
        tracker, ['/profiles'], 'Research', 'Task', '/cwd',
        'The plan lacks detail',
      );

      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      const prompt = callOpts.prompt as string;
      expect(prompt).toContain('Previous plan was rejected');
      expect(prompt).toContain('The plan lacks detail');
    });

    it('includes suggestions in the prompt when provided with feedback', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ tasks: [], strategy: '' });

      await planningPhase(
        tracker, ['/profiles'], 'Research', 'Task', '/cwd',
        'Needs improvement', ['Add error handling', 'Add tests'],
      );

      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      const prompt = callOpts.prompt as string;
      expect(prompt).toContain('Specific suggestions:');
      expect(prompt).toContain('- Add error handling');
      expect(prompt).toContain('- Add tests');
    });

    it('skips suggestions when array is empty', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ tasks: [], strategy: '' });

      await planningPhase(
        tracker, ['/profiles'], 'Research', 'Task', '/cwd',
        'Needs improvement', [],
      );

      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      const prompt = callOpts.prompt as string;
      expect(prompt).toContain('Previous plan was rejected');
      expect(prompt).not.toContain('Specific suggestions:');
    });

    it('omits feedback section when no feedback provided', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ tasks: [], strategy: '' });

      await planningPhase(
        tracker, ['/profiles'], 'Research', 'Task', '/cwd',
      );

      const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      const prompt = callOpts.prompt as string;
      expect(prompt).not.toContain('Previous plan was rejected');
    });
  });

  // ─── Workflow data ────────────────────────────────────────────────────────

  it('calls setWorkflowData with the plan', async () => {
    const tracker = makeMockTracker();
    const plan: Plan = {
      tasks: [{
        id: 't1', title: 'Task 1', prompt: 'Do',
        profile: 'implementer', files: ['f.ts'], is_code: true, dependencies: [],
      }],
      strategy: 'Iterative',
    };
    mockRunStepTask.mockResolvedValueOnce(plan);

    await planningPhase(tracker, ['/profiles'], 'Research', 'Task', '/cwd');

    expect(tracker.setWorkflowData).toHaveBeenCalledWith({ plan });
  });

  // ─── Audit log ────────────────────────────────────────────────────────────

  it('appends a structured_output event to the audit log', async () => {
    const tracker = makeMockTracker();
    const plan: Plan = {
      tasks: [{
        id: 't1', title: 'Task 1', prompt: 'Do',
        profile: 'implementer', files: ['f.ts'], is_code: false, dependencies: [],
      }],
      strategy: 'Simple',
    };
    mockRunStepTask.mockResolvedValueOnce(plan);

    await planningPhase(tracker, ['/profiles'], 'Research', 'Task', '/cwd');

    expect(tracker.auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'structured_output',
        agentId: 'planner',
        output: plan,
      }),
    );
  });
});

// ─── PlanReviewPhase tests ──────────────────────────────────────────────────

describe('planReviewPhase', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  // ─── Basic execution ──────────────────────────────────────────────────────

  it('calls runStepTask with correct options', async () => {
    const tracker = makeMockTracker();
    const plan: Plan = {
      tasks: [{
        id: 't1', title: 'Task', prompt: 'Do',
        profile: 'implementer', files: ['f.ts'], is_code: true, dependencies: [],
      }],
      strategy: 'Plan',
    };
    const reviewResult: PlanReview = { ready: true, feedback: 'Looks good', suggestions: [] };
    mockRunStepTask.mockResolvedValueOnce(reviewResult);

    const result = await planReviewPhase(
      tracker, ['/profiles'], plan, 'Research', 'Task', '/cwd',
    );

    expect(result).toBe(reviewResult);
    expect(mockRunStepTask).toHaveBeenCalledTimes(1);

    const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(callOpts.taskId).toBe('plan-reviewer');
    expect(callOpts.phaseId).toBe('planning');
    expect(callOpts.stepName).toBe('review-plan');
    expect(callOpts.profileId).toBe('plan-reviewer');
    expect(callOpts.isReadOnly).toBe(true);
    expect(callOpts.prompt).toContain('reviewing an implementation plan');
    expect(callOpts.prompt).toContain('Research');
    expect(callOpts.prompt).toContain(JSON.stringify(plan, null, 2));
  });

  it('passes apiKeys, onStatus, and signal through to runStepTask', async () => {
    const tracker = makeMockTracker();
    const apiKeys = { openai: 'sk-test' };
    const onStatus = makeStatusCallbacksSpy();
    const abortController = new AbortController();
    mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: '', suggestions: [] });

    await planReviewPhase(
      tracker, ['/profiles'], { tasks: [], strategy: '' }, 'Research', 'Task', '/cwd',
      apiKeys, onStatus, abortController.signal,
    );

    const callOpts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(callOpts.apiKeys).toBe(apiKeys);
    expect(callOpts.onStatus).toBe(onStatus);
    expect(callOpts.signal).toBe(abortController.signal);
  });

  // ─── onDecision callback ──────────────────────────────────────────────────

  describe('onDecision callback', () => {
    it('fires onDecision with plan_approved when ready is true', async () => {
      const tracker = makeMockTracker();
      const onStatus = makeStatusCallbacksSpy();
      mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'Approved', suggestions: [] });

      await planReviewPhase(
        tracker, ['/profiles'], { tasks: [], strategy: '' }, 'Research', 'Task', '/cwd',
        undefined, onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledTimes(1);
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'plan-reviewer',
        decision: 'plan_approved',
        reasoning: 'Approved',
      });
    });

    it('fires onDecision with plan_rejected when ready is false', async () => {
      const tracker = makeMockTracker();
      const onStatus = makeStatusCallbacksSpy();
      mockRunStepTask.mockResolvedValueOnce({
        ready: false,
        feedback: 'Missing details',
        suggestions: ['Add more detail'],
      });

      await planReviewPhase(
        tracker, ['/profiles'], { tasks: [], strategy: '' }, 'Research', 'Task', '/cwd',
        undefined, onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'plan-reviewer',
        decision: 'plan_rejected',
        reasoning: 'Missing details',
      });
    });

    it('does not throw when onStatus is undefined', async () => {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'OK', suggestions: [] });

      await expect(
        planReviewPhase(tracker, ['/profiles'], { tasks: [], strategy: '' }, 'Research', 'Task', '/cwd'),
      ).resolves.toBeDefined();
    });
  });

  // ─── Audit log ────────────────────────────────────────────────────────────

  it('appends a decision event to the audit log', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'Plan approved', suggestions: [] });

    await planReviewPhase(
      tracker, ['/profiles'], { tasks: [], strategy: '' }, 'Research', 'Task', '/cwd',
    );

    expect(tracker.auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'decision',
        agentId: 'plan-reviewer',
        decision: 'plan_approved',
        reasoning: 'Plan approved',
      }),
    );
  });
});
