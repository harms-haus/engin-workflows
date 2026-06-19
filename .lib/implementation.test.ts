// ─── Implementation Phase Tests ─────────────────────────────────────────────
//
// Tests for implementation.ts: phaseId threading in addTask, LanePool
// construction with phaseId, and pool result handling.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';
import { createEnginMock } from './engin-mock';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
const mockAddTask = jest.fn<(task: { id: string; title: string; prompt: string; profile: string; files: string[]; dependencies: string[]; isCode: boolean; phaseId: string }) => void>();
const mockAssignSequentialTaskIds = jest.fn((tasks: { id: string; dependencies: string[] }[]) => {
  // Default: renumber IDs like the real function (t-01, t-02, …) and remap deps
  const idMap = new Map<string, string>();
  const result = tasks.map((t, i) => {
    const newId = `t-${String(i + 1).padStart(2, '0')}`;
    idMap.set(t.id, newId);
    return { ...t, id: newId };
  });
  for (const t of result) {
    t.dependencies = t.dependencies.map((d: string) => idMap.get(d) ?? d);
  }
  return result;
});
const mockValidateAllDependencies = jest.fn<() => void>();
const mockGetAllTasks = jest.fn<() => { id: string; status: string }[]>();
const mockGetTask = jest.fn<(id: string) => { id: string } | undefined>();
const mockPoolRun = jest.fn<() => Promise<{ completedTasks: number; failedTasks: number }>>();
const mockClearTaskSessions = jest.fn<(sessionBaseDir: string, taskId: string) => void>();

const MockTaskTracker = jest.fn().mockImplementation(() => ({
  addTask: mockAddTask,
  validateAllDependencies: mockValidateAllDependencies,
  getAllTasks: mockGetAllTasks,
  getTask: mockGetTask,
}));

const MockLanePool = jest.fn().mockImplementation(() => ({
  run: mockPoolRun,
}));

mock.module('@harms-haus/engin-engine', () => ({
  ...createEnginMock(),
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  clearTaskSessions: mockClearTaskSessions,
  assignSequentialTaskIds: mockAssignSequentialTaskIds,
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

/**
 * Extract the `beforeTask` step-substitution hook that `implementationPhase`
 * registers on the LanePool's hookRegistry. Returns the hook function so tests
 * can invoke it directly with a task and assert the returned `{ steps }`.
 */
function extractBeforeTaskHook(): (args: { task: unknown; steps: unknown[] }) => { steps: { name: string; profileId: string; isReadOnly: boolean }[] } | undefined {
  const poolOptions = MockLanePool.mock.calls[0][0];
  expect(poolOptions).toHaveProperty('hookRegistry');
  const registry = poolOptions.hookRegistry as { register: { mock: { calls: unknown[][] } } };
  for (const call of registry.register.mock.calls) {
    const hooks = call[0] as Record<string, unknown> | undefined;
    if (hooks && 'beforeTask' in hooks) {
      const value = hooks.beforeTask;
      // The hook may be registered as a single fn or fn[] (both are valid).
      const fn = Array.isArray(value) ? value[0] : value;
      if (typeof fn === 'function') return fn as never;
    }
  }
  throw new Error('beforeTask hook was not registered on the hookRegistry');
}

// ─── PhaseId Threading ──────────────────────────────────────────────────────

describe('implementationPhase — phaseId threading', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
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
      id: 't-01',
      title: 'Add feature A',
      prompt: 'Implement feature A in module X',
      profile: 'implementer',
      files: ['src/x.ts'],
      dependencies: [],
      isCode: true,
      phaseId: 'implementing',
    });

    expect(mockAddTask).toHaveBeenNthCalledWith(2, {
      id: 't-02',
      title: 'Update docs',
      prompt: 'Document feature A',
      profile: 'implementer',
      files: ['README.md'],
      dependencies: ['t-01'],
      isCode: false,
      phaseId: 'implementing',
    });
  });

  it('skips addTask for tasks already in the tracker', async () => {
    const tracker = makeMockTracker();
    // Simulate t-01 (renumbered from task-1) already present
    mockGetTask.mockImplementation((id: string) => {
      return id === 't-01' ? { id: 't-01' } : undefined;
    });

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    // Only t-02 should be added (t-01 already exists)
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 't-02',
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

  it('registers a beforeTask hook on the hookRegistry passed to LanePool', async () => {
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
    // FIX C: both getStepsForTask (registration-time seed for onTaskRegister)
    // and hookRegistry (claim-time beforeTask hook) are threaded into LanePool.
    expect(poolOptions).toHaveProperty('hookRegistry');
    expect(poolOptions).toHaveProperty('getStepsForTask');
    expect(typeof poolOptions.getStepsForTask).toBe('function');

    // FIX C: getStepsForTask returns CODE_STEPS for a code task (registration-time seed).
    const codeTask = { id: 't1', title: '', prompt: '', profile: 'implementer', files: [], dependencies: [], isCode: true } as any;
    const stepsFromHelper = poolOptions.getStepsForTask(codeTask);
    expect(Array.isArray(stepsFromHelper)).toBe(true);
    expect(stepsFromHelper.length).toBeGreaterThan(0);
    expect(stepsFromHelper[0].name).toBe('write-tests'); // first CODE_STEP

    // The beforeTask step-substitution hook is registered on that registry.
    const registry = poolOptions.hookRegistry as { register: { mock: { calls: unknown[][] } } };
    const registerCalls = registry.register.mock.calls;
    const hooksWithBeforeTask = registerCalls
      .map((c: unknown[]) => c[0])
      .filter((h: unknown): h is { beforeTask: unknown } => !!h && typeof h === 'object' && 'beforeTask' in h);
    expect(hooksWithBeforeTask.length).toBeGreaterThanOrEqual(1);
  });

  it('beforeTask hook returns CODE_STEPS for code tasks (write-tests first)', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const beforeTask = extractBeforeTaskHook();

    const codeTask = { id: 't1', title: '', prompt: '', profile: 'implementer', files: [], dependencies: [], isCode: true } as any;
    const result = beforeTask({ task: codeTask, steps: [] });

    expect(result).toBeDefined();
    expect(Array.isArray(result!.steps)).toBe(true);
    expect(result!.steps.length).toBeGreaterThan(0);
    // Code tasks should have write-tests as first step
    expect(result!.steps[0].name).toBe('write-tests');
  });

  it('beforeTask hook returns NON_CODE_STEPS for non-code tasks (execute + review)', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const beforeTask = extractBeforeTaskHook();

    const nonCodeTask = { id: 't2', title: '', prompt: '', profile: 'implementer', files: [], dependencies: [], isCode: false } as any;
    const result = beforeTask({ task: nonCodeTask, steps: [] });

    expect(result).toBeDefined();
    expect(result!.steps.length).toBe(2);
    expect(result!.steps[0].name).toBe('execute');
    expect(result!.steps[1].name).toBe('review');
  });

  it('beforeTask hook substitutes a custom implementer profile into the execute step', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const beforeTask = extractBeforeTaskHook();

    const customProfileTask = { id: 't3', title: '', prompt: '', profile: 'implementer-lite', files: [], dependencies: [], isCode: true } as any;
    const result = beforeTask({ task: customProfileTask, steps: [] });

    expect(result).toBeDefined();
    const executeStep = result!.steps.find((s: { name: string }) => s.name === 'execute');
    expect(executeStep).toBeDefined();
    expect(executeStep!.profileId).toBe('implementer-lite');
  });

  it('beforeTask hook preserves reviewer/test-writer profiles when substituting the implementer', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    const beforeTask = extractBeforeTaskHook();

    const customProfileTask2 = { id: 't4', title: '', prompt: '', profile: 'implementer-lite', files: [], dependencies: [], isCode: true } as any;
    const result = beforeTask({ task: customProfileTask2, steps: [] });

    expect(result).toBeDefined();
    // write-tests should still use 'test-writer'
    const writeTestsStep = result!.steps.find((s: { name: string }) => s.name === 'write-tests');
    expect(writeTestsStep).toBeDefined();
    expect(writeTestsStep!.profileId).toBe('test-writer');

    // review step should still use 'implement-reviewer'
    const reviewStep = result!.steps.find((s: { name: string }) => s.name === 'review');
    expect(reviewStep).toBeDefined();
    expect(reviewStep!.profileId).toBe('implement-reviewer');
  });

  it('forwards a provided hookRegistry into LanePool and registers beforeTask on it', async () => {
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
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
      undefined,
      undefined,
      undefined,
      undefined,
      customRegistry as never,
    );

    const poolOptions = MockLanePool.mock.calls[0][0];
    // The PROVIDED registry is forwarded (not a freshly-created one).
    expect(poolOptions.hookRegistry).toBe(customRegistry);
    // The beforeTask hook is registered on the provided registry.
    expect(customRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({ beforeTask: expect.any(Function) }),
    );
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
    mockClearTaskSessions.mockClear();
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
    mockClearTaskSessions.mockClear();
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

// ─── Retry & Session Reset ────────────────────────────────────────────────

describe('implementationPhase — retry & session reset', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockLanePool.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('passes maxTaskRetries: 2 to the LanePool (3 total attempts per task)', async () => {
    mockGetAllTasks.mockReturnValue([]);
    const tracker = makeMockTracker();

    await implementationPhase(tracker, ['/profiles'], SAMPLE_PLAN, '/cwd', 5, '/work');

    expect(MockLanePool).toHaveBeenCalledWith(expect.objectContaining({ maxTaskRetries: 2 }));
  });

  it('clears sessions for non-complete tasks before the pool runs (resume path)', async () => {
    // On a resume, failed / interrupted tasks must restart from step 1 with
    // a clean slate; only completed tasks keep their sessions.
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'complete' },
      { id: 'task-2', status: 'failed' },
      { id: 'task-3', status: 'ready' },
    ]);
    const tracker = makeMockTracker();

    await implementationPhase(tracker, ['/profiles'], SAMPLE_PLAN, '/cwd', 5, '/work');

    const clearedIds = mockClearTaskSessions.mock.calls.map((c) => c[1]);
    expect(clearedIds).toEqual(['task-2', 'task-3']);
    expect(clearedIds).not.toContain('task-1');
    // sessionBaseDir passed is {workDir}/sessions
    expect(mockClearTaskSessions.mock.calls[0][0]).toContain('/work/sessions');
  });

  it('clears sessions for all tasks on a fresh run (none are complete yet)', async () => {
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'ready' },
      { id: 'task-2', status: 'ready' },
    ]);
    const tracker = makeMockTracker();

    await implementationPhase(tracker, ['/profiles'], SAMPLE_PLAN, '/cwd', 5, '/work');

    const clearedIds = mockClearTaskSessions.mock.calls.map((c) => c[1]);
    expect(clearedIds).toEqual(['task-1', 'task-2']);
  });

  it('does not clear any sessions when every task is complete', async () => {
    mockGetAllTasks.mockReturnValue([
      { id: 'task-1', status: 'complete' },
      { id: 'task-2', status: 'complete' },
    ]);
    const tracker = makeMockTracker();

    await implementationPhase(tracker, ['/profiles'], SAMPLE_PLAN, '/cwd', 5, '/work');

    expect(mockClearTaskSessions).not.toHaveBeenCalled();
  });
});

// ─── rendererRegistry and task-id renumbering ─────────────────────────────

describe('implementationPhase — rendererRegistry and task-id renumbering', () => {
  beforeEach(() => {
    mockAddTask.mockClear();
    mockValidateAllDependencies.mockClear();
    mockGetAllTasks.mockClear();
    mockGetTask.mockClear();
    mockPoolRun.mockClear();
    mockClearTaskSessions.mockClear();
    MockLanePool.mockClear();
    mockAssignSequentialTaskIds.mockClear();
    mockGetTask.mockReturnValue(undefined);
    mockPoolRun.mockResolvedValue({ completedTasks: 2, failedTasks: 0 });
    mockGetAllTasks.mockReturnValue([
      { id: 't-01', status: 'done' },
      { id: 't-02', status: 'done' },
    ]);
  });

  it('renumbers task ids: arbitrary IDs become sequential (t-01, t-02) and dependencies are remapped', async () => {
    const tracker = makeMockTracker();
    const planWithArbitraryIds: Plan = {
      tasks: [
        {
          id: 'auth-a',
          title: 'Auth module',
          prompt: 'Implement auth',
          profile: 'implementer',
          files: ['src/auth.ts'],
          is_code: true,
          dependencies: [],
        },
        {
          id: 'auth-b',
          title: 'Auth tests',
          prompt: 'Write auth tests',
          profile: 'implementer',
          files: ['src/auth.test.ts'],
          is_code: true,
          dependencies: ['auth-a'],
        },
      ],
      strategy: 'Auth first',
    };

    await implementationPhase(
      tracker,
      ['/profiles'],
      planWithArbitraryIds,
      '/cwd',
      5,
      '/work',
    );

    // The tracker should receive the renumbered IDs
    const addedIds = mockAddTask.mock.calls.map(c => c[0].id);
    expect(addedIds).toContain('t-01');
    expect(addedIds).toContain('t-02');

    // First task: no dependencies
    expect(mockAddTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: 't-01',
      dependencies: [],
    }));

    // Second task: dependency remapped from 'auth-a' to 't-01'
    expect(mockAddTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 't-02',
      dependencies: ['t-01'],
    }));
  });

  it('assignSequentialTaskIds is called with plan.tasks and OLD ids never reach the tracker', async () => {
    const tracker = makeMockTracker();
    const planWithArbitraryIds: Plan = {
      tasks: [
        {
          id: 'auth-a',
          title: 'Auth module',
          prompt: 'Implement auth',
          profile: 'implementer',
          files: ['src/auth.ts'],
          is_code: true,
          dependencies: [],
        },
        {
          id: 'auth-b',
          title: 'Auth tests',
          prompt: 'Write auth tests',
          profile: 'implementer',
          files: ['src/auth.test.ts'],
          is_code: true,
          dependencies: ['auth-a'],
        },
      ],
      strategy: 'Auth first',
    };

    await implementationPhase(
      tracker,
      ['/profiles'],
      planWithArbitraryIds,
      '/cwd',
      5,
      '/work',
    );

    // assignSequentialTaskIds must have been called
    expect(mockAssignSequentialTaskIds).toHaveBeenCalledTimes(1);
    expect(mockAssignSequentialTaskIds).toHaveBeenCalledWith(planWithArbitraryIds.tasks);

    // OLD IDs must NEVER reach the tracker
    const addedIds = mockAddTask.mock.calls.map(c => c[0].id);
    expect(addedIds).not.toContain('auth-a');
    expect(addedIds).not.toContain('auth-b');
  });

  it('forwards rendererRegistry into LanePool options when provided', async () => {
    const tracker = makeMockTracker();
    const fakeRegistry = { renderers: new Map(), register: jest.fn(), get: jest.fn(), render: jest.fn() };

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
      fakeRegistry,
    );

    expect(MockLanePool).toHaveBeenCalledTimes(1);
    const poolOptions = MockLanePool.mock.calls[0][0];
    expect(poolOptions).toHaveProperty('rendererRegistry', fakeRegistry);
  });

  it('rendererRegistry is optional: omitting it still works', async () => {
    const tracker = makeMockTracker();

    await implementationPhase(
      tracker,
      ['/profiles'],
      SAMPLE_PLAN,
      '/cwd',
      5,
      '/work',
    );

    // Should not throw and pool should still be created
    expect(MockLanePool).toHaveBeenCalledTimes(1);
    const poolOptions = MockLanePool.mock.calls[0][0];
    expect(poolOptions.rendererRegistry).toBeUndefined();
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
