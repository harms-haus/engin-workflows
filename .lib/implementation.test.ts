// ─── Implementation Phase Tests ─────────────────────────────────────────────
//
// Tests for implementation.ts: phaseId threading in addTask, LanePool
// construction with phaseId, and pool result handling.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
const mockAddTask = jest.fn<(task: { id: string; title: string; prompt: string; profile: string; files: string[]; dependencies: string[]; isCode: boolean; phaseId: string }) => void>();
const mockValidateAllDependencies = jest.fn<() => void>();
const mockGetAllTasks = jest.fn<() => { id: string; status: string }[]>();
const mockGetTask = jest.fn<(id: string) => { id: string } | undefined>();
const mockPoolRun = jest.fn<() => Promise<{ completedTasks: number; failedTasks: number }>>();

const MockTaskTracker = jest.fn().mockImplementation(() => ({
  addTask: mockAddTask,
  validateAllDependencies: mockValidateAllDependencies,
  getAllTasks: mockGetAllTasks,
  getTask: mockGetTask,
}));

const MockLanePool = jest.fn().mockImplementation(() => ({
  run: mockPoolRun,
}));

mock.module('@harms-haus/engin', () => ({
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  WorkflowStatusTracker: jest.fn().mockImplementation(() => ({
    setPhase: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    setWorkflowData: jest.fn(),
    get workflowData() {
      return {};
    },
    get currentPhase() {
      return '';
    },
    get completedPhases() {
      return [];
    },
  })),
  loadProfilesFromDirs: async () => new Map(),
  forwardAgentStatus: (cb: unknown) => cb,
}));

// Dynamic import to ensure mock is applied first
const { implementationPhase } = await import('./implementation');

import type { Plan } from './schemas';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_PLAN: Plan = {
  tasks: [
    {
      id: 'task-1',
      title: 'Add feature A',
      prompt: 'Implement feature A in module X',
      profile: 'implementer',
      files: ['src/x.ts'],
      is_code: true,
      dependencies: [],
    },
    {
      id: 'task-2',
      title: 'Update docs',
      prompt: 'Document feature A',
      profile: 'implementer',
      files: ['README.md'],
      is_code: false,
      dependencies: ['task-1'],
    },
  ],
  strategy: 'Implement in order',
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

// ─── PhaseId Threading ──────────────────────────────────────────────────────

describe('implementationPhase — phaseId threading', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    MockLanePool.mockClear();
    // Default: pool returns all tasks as completed
    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    // Default: getTask returns undefined (task not already present)
    mockGetTask.mockReturnValue(undefined);
    // Default: getAllTasks returns the expected tasks
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'done' },
      { id: 'task-2', status: 'done' },
    ]);
  });

  it('calls addTask with phaseId: "implementing" for each plan task', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
      undefined,
      undefined,
      undefined,
    );

    expect(mockAddTask).toHaveBeenCalledTimes(2);

    expect(mockAddTask).toHaveBeenNthCalledWith(1, {
      id: 'task-1',
      title: 'Add feature A',
      prompt: 'Implement feature A in module X',
      profile: 'implementer',
      files: ['src/x.ts'],
      dependencies: [],
      isCode: true,
      phaseId: 'implementing',
    });

    expect(mockAddTask).toHaveBeenNthCalledWith(2, {
      id: 'task-2',
      title: 'Update docs',
      prompt: 'Document feature A',
      profile: 'implementer',
      files: ['README.md'],
      dependencies: ['task-1'],
      isCode: false,
      phaseId: 'implementing',
    });
  });

  it('skips addTask for tasks already in the tracker', async () => {
    const tracker = makeMockTracker();
    // Simulate task-1 already present
    mockGetTask.mockImplementation((id: string) => {
      return id === 'task-1' ? { id: 'task-1' } : undefined;
    });

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    // Only task-2 should be added (task-1 already exists)
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-2',
    }));
  });

  it('calls validateAllDependencies after adding tasks', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(mockValidateAllDependencies).toHaveBeenCalledTimes(1);
  });

  it('creates LanePool with phaseId: "implementing"', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(MockLanePool).toHaveBeenCalledTimes(1);
    const poolOptions = MockLanePool.mock.calls[0][0];

    expect(poolOptions).toHaveProperty('phaseId', 'implementing');
    expect(poolOptions).toHaveProperty('maxConcurrentLanes', 5);
    expect(poolOptions).toHaveProperty('profilesDirs', ['/profiles']);
    expect(poolOptions).toHaveProperty('cwd', '/cwd');
    expect(poolOptions).toHaveProperty('sessionBaseDir');
    expect(poolOptions.sessionBaseDir).toContain('/work/sessions');
  });

  it('passes maxConcurrentTasks as maxConcurrentLanes to LanePool', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      3,
      '/work',
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentLanes: 3 }),
    );
  });

  it('passes apiKeys and onStatus through to LanePool when provided', async () => {
    const tracker = makeMockTracker();
    const onStatus = { onAgentSpawn: jest.fn() };
    const apiKeys = { ANTHROPIC: 'sk-test' };

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
      apiKeys,
      onStatus as never,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeys,
        onStatus,
      }),
    );
  });

  it('passes auditLog and taskTracker to LanePool', async () => {
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
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        auditLog: { append: expect.any(Function) },
        taskTracker: expect.any(Object),
      }),
    );
  });

  it('calls pool.run() and awaits it', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(mockPoolRun).toHaveBeenCalledTimes(1);
  });

  it('provides a getStepsForTask callback that uses CODE_STEPS for code tasks', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const poolOptions = MockLanePool.mock.calls[0][0];
    const getSteps = poolOptions.getStepsForTask;

    // Verify it returns an array of steps
    const codeTask = { id: 't1', title: '', prompt: '', profile: 'implementer', files: [], dependencies: [], isCode: true } as any;
    const steps = getSteps(codeTask);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
    // Code tasks should have write-tests as first step
    expect(steps[0].name).toBe('write-tests');
  });

  it('provides a getStepsForTask callback that uses NON_CODE_STEPS for non-code tasks', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const poolOptions = MockLanePool.mock.calls[0][0];
    const getSteps = poolOptions.getStepsForTask;

    // Non-code task should not have test steps
    const nonCodeTask = { id: 't2', title: '', prompt: '', profile: 'implementer', files: [], dependencies: [], isCode: false } as any;
    const steps = getSteps(nonCodeTask);
    expect(steps.length).toBe(2);
    expect(steps[0].name).toBe('execute');
    expect(steps[1].name).toBe('review');
  });

  it('getStepsForTask substitutes custom profile for implementer step', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const poolOptions = MockLanePool.mock.calls[0][0];
    const getSteps = poolOptions.getStepsForTask;

    const customProfileTask = { id: 't3', title: '', prompt: '', profile: 'implementer-lite', files: [], dependencies: [], isCode: true } as any;
    const steps = getSteps(customProfileTask);
    const executeStep = steps.find((s: { name: string }) => s.name === 'execute');
    expect(executeStep).toBeDefined();
    expect(executeStep!.profileId).toBe('implementer-lite');
  });

  it('getStepsForTask preserves other step profiles when substituting', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const poolOptions = MockLanePool.mock.calls[0][0];
    const getSteps = poolOptions.getStepsForTask;

    const customProfileTask2 = { id: 't4', title: '', prompt: '', profile: 'implementer-lite', files: [], dependencies: [], isCode: true } as any;
    const steps2 = getSteps(customProfileTask2);

    // write-tests should still use 'test-writer'
    const writeTestsStep = steps2.find((s: { name: string }) => s.name === 'write-tests');
    expect(writeTestsStep).toBeDefined();
    expect(writeTestsStep!.profileId).toBe('test-writer');

    // review step should still use 'implement-reviewer'
    const reviewStep = steps2.find((s: { name: string }) => s.name === 'review');
    expect(reviewStep).toBeDefined();
    expect(reviewStep!.profileId).toBe('implement-reviewer');
  });
});

// ─── Pool Result Discrepancy ────────────────────────────────────────────────

describe('implementationPhase — pool result handling', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    MockLanePool.mockClear();
    mockGetTask.mockReturnValue(undefined);
  });

  it('logs a warning when pool result does not match tracker state', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = makeMockTracker();

    // Pool returns fewer completed tasks than total tasks
    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'done' },
      { id: 'task-2', status: 'done' },
    ]);

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Pool result discrepancy'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 completed'),
    );

    consoleWarnSpy.mockRestore();
  });

  it('does not warn when pool result matches tracker state', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = makeMockTracker();

    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'done' },
      { id: 'task-2', status: 'done' },
    ]);

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('warns correctly with mixed completed/failed tasks', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = makeMockTracker();

    // 1 completed + 1 failed = 2 settled, but only 1 task in tracker
    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 1 });
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'done' },
    ]);

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('2 settled'),
    );

    consoleWarnSpy.mockRestore();
  });

  it('computes settled tasks as completedTasks + failedTasks', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = makeMockTracker();

    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 2 });
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'done' },
      { id: 'task-2', status: 'failed' },
    ]);

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('3 settled tasks (1 completed + 2 failed) vs 2 total tasks'),
    );

    consoleWarnSpy.mockRestore();
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('implementationPhase — edge cases', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    MockLanePool.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockPoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });
  });

  it('handles an empty plan (no tasks)', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = makeMockTracker();

    const emptyPlan: Plan = { tasks: [], strategy: '' };

    mockGetAllTasks.mockReturnValue([]);
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

    await implementationPhase(
      tracker,
      ['/profiles'],
      emptyPlan,
      '/cwd',
      5,
      '/work',
    );

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockValidateAllDependencies).toHaveBeenCalled();
    expect(mockPoolRun).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it('passes signal through to LanePool when provided', async () => {
    const tracker = makeMockTracker();
    const abortController = new AbortController();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
      undefined,
      undefined,
      abortController.signal,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: abortController.signal,
      }),
    );
  });

  it('uses default maxConcurrentTasks=5 when not specified', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      undefined as never,
      '/work',
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentLanes: 5 }),
    );
  });
});

// ─── Type-level: LanePoolOptions uses phaseId (not phase) ──────────────────

describe('implementationPhase — LanePoolOptions type', () => {
  it('LanePool is constructed with phaseId field (not phase)', () => {
    // Verify through the mock that phaseId was passed
    const tracker = makeMockTracker();

    // This is a compile-time check in the source; at runtime we verify
    // via the mock that the object has phaseId and NOT phase.
    // We check that the mock was called with phaseId
    return implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    ).then(() => {
      const callArg = MockLanePool.mock.calls[0][0];
      expect(callArg).toHaveProperty('phaseId');
      // phaseId should be 'implementing'
      expect(callArg.phaseId).toBe('implementing');
    });
  });

  it('does not pass legacy phase field to LanePool', () => {
    const tracker = makeMockTracker();

    return implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    ).then(() => {
      const callArg = MockLanePool.mock.calls[0][0];
      // The legacy 'phase' field should not be present
      expect(callArg).not.toHaveProperty('phase');
    });
  });
});
