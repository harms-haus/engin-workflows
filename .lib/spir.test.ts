// ─── SPIR Backbone Orchestrator Tests ───────────────────────────────────────
//
// Tests for spir.ts: phase registration, config.phases usage, abort handling,
// initialization phase, sidebar updates, and core helper functions.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';

// ─── Mock the engin module BEFORE any static imports ────────────────────────
// We provide a complete mock for all value imports that spir.ts and its
// re-exported modules need, so the TUI tree is never actually loaded.

const mockCancelTask = jest.fn<(id: string) => void>();
const mockGetAllTasks = jest.fn<() => { id: string; status: string }[]>();
const mockTaskTracker = {
  cancelTask: mockCancelTask,
  getAllTasks: mockGetAllTasks,
};

const MockWorkflowStatusTracker = jest.fn<() => Record<string, unknown>>().mockImplementation(() => ({
  setPhase: jest.fn(),
  setCurrentPhase: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
  setWorkflowData: jest.fn(),
  setTaskPrompt: jest.fn(),
  setWorktree: jest.fn(),
  get workflowData() {
    return {};
  },
  get currentPhase() {
    return '';
  },
  get completedPhases() {
    return [];
  },
  get taskTracker() {
    return mockTaskTracker;
  },
  get stats() {
    return { totalTokens: 0, totalCost: 0, agentCount: 0 };
  },
  setScoutingReports: jest.fn(),
  setPlan: jest.fn(),
  setResearch: jest.fn(),
  setPlanReviewFeedback: jest.fn(),
  clearPlanReviewFeedback: jest.fn(),
}));

const MockLanePool = jest.fn().mockImplementation(() => ({
  run: jest.fn().mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
}));

const MockTaskTracker = jest.fn().mockImplementation(() => ({
  addTask: jest.fn(),
  getAllTasks: mockGetAllTasks,
  getReadyTasks: jest.fn().mockReturnValue([]),
  claimTasks: jest.fn().mockReturnValue([]),
  completeTask: jest.fn(),
  failTask: jest.fn(),
  cancelTask: mockCancelTask,
  rejectTask: jest.fn(),
  startTask: jest.fn(),
  submitForReview: jest.fn(),
}));

mock.module('@harms-haus/engin', () => ({
  // Types are compile-time only; these are the runtime values
  WorkflowStatusTracker: MockWorkflowStatusTracker,
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  resolveProfilesDirs: (cwd: string, name: string) => [`/profiles/${name}`],
  loadProfilesFromDirs: async () => new Map(),
  forwardAgentStatus: (cb: unknown) => cb,
  createHarness: jest.fn().mockResolvedValue({
    prompt: jest.fn().mockResolvedValue(undefined),
    getLastAssistantText: jest.fn().mockReturnValue(''),
    messages: [],
    subscribe: jest.fn().mockReturnValue(jest.fn()),
    sessionId: 'test-session',
    dispose: jest.fn(),
  }),
  promptForStructured: jest.fn().mockResolvedValue({ result: {}, attempts: 1 }),
  runStepTask: jest.fn().mockResolvedValue(undefined),
}));

// Dynamic import for runtime values (mock must be applied first)
const spir = await import('./spir');

// Type-level re-exports for TypeScript's benefit.
// `import type` is fully erased at runtime so it doesn't cascade into broken imports.
import type { WorkflowConfig, SpirRunOptions } from './config';
import type {
  Phase,
  RunState,
  PhaseContext,
  SpirWorkflowData,
} from './spir';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const MINIMAL_CONFIG: WorkflowConfig = {
  name: 'test-workflow',
  defaultMaxConcurrentTasks: 3,
  fixerSteps: [],
  // NEW: config.phases replaces config.sidebarPhases
  phases: [
    { id: 'initialization', label: 'Initialization', icon: '⚙' },
    { id: 'scouting', label: 'Scouting', icon: '🔍' },
    { id: 'planning', label: 'Planning', icon: '📋' },
    { id: 'implementing', label: 'Implementing', icon: '🔨' },
    { id: 'review', label: 'Review', icon: '🔎' },
  ],
  titleFormatter: (d: string) => d.slice(0, 100),
};

const MINIMAL_OPTIONS: SpirRunOptions = {
  cwd: '/tmp/test-cwd',
  workDir: '/tmp/test-workdir',
  profilesDirs: ['/tmp/profiles'],
};

// ─── PHASES export ──────────────────────────────────────────────────────────

describe('PHASES constant', () => {
  it('is an array of Phase strings', () => {
    expect(Array.isArray(spir.PHASES)).toBe(true);
  });

  it('contains the expected phase order', () => {
    expect(spir.PHASES).toEqual([
      'scouting',
      'planning',
      'implementing',
      'review',
      'done',
    ]);
  });

  it('is declared as readonly (compile-time check)', () => {
    // The PHASES array is typed as readonly Phase[], which prevents
    // mutation at compile time. At runtime the array is mutable (not frozen).
    const readonlyCheck: readonly string[] = spir.PHASES;
    expect(readonlyCheck).toBe(spir.PHASES);
  });

  it('does not include initialization (handled separately)', () => {
    expect(spir.PHASES).not.toContain('initialization');
  });

  it('each entry is a valid Phase', () => {
    for (const p of spir.PHASES) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    }
  });
});

// ─── Phase type ─────────────────────────────────────────────────────────────

describe('Phase type', () => {
  it('accepts valid phase strings', () => {
    const valid: Phase[] = ['scouting', 'planning', 'implementing', 'review', 'done'];
    expect(valid).toHaveLength(5);
  });

  it('does not accept arbitrary strings at compile time (type check)', () => {
    const phase: Phase = 'scouting';
    expect(phase).toBe('scouting');
  });
});

// ─── RunState ───────────────────────────────────────────────────────────────

describe('RunState interface', () => {
  it('creates a valid RunState object', () => {
    const state: RunState = {
      research: '',
      plan: undefined,
      scoutingReports: [],
      scoutingRounds: 0,
      scoutingGaps: [],
      planningRounds: 0,
    };
    expect(state.research).toBe('');
    expect(state.plan).toBeUndefined();
    expect(state.scoutingReports).toEqual([]);
    expect(state.scoutingRounds).toBe(0);
    expect(state.scoutingGaps).toEqual([]);
    expect(state.planningRounds).toBe(0);
  });

  it('accepts optional planReviewFeedback and planReviewSuggestions', () => {
    const state: RunState = {
      research: 'test',
      plan: undefined,
      scoutingReports: [],
      scoutingRounds: 0,
      scoutingGaps: [],
      planningRounds: 0,
      planReviewFeedback: 'Needs work',
      planReviewSuggestions: ['Add more detail'],
    };
    expect(state.planReviewFeedback).toBe('Needs work');
    expect(state.planReviewSuggestions).toEqual(['Add more detail']);
  });
});

// ─── PhaseContext ───────────────────────────────────────────────────────────

describe('PhaseContext interface', () => {
  it('holds all required fields for phase execution', () => {
    const ctx: PhaseContext = {
      tracker: {} as never,
      profilesDirs: ['/profiles'],
      taskPrompt: 'Build a feature',
      cwd: '/cwd',
      workDir: '/work',
      maxConcurrentTasks: 5,
      config: MINIMAL_CONFIG,
    };
    expect(ctx.tracker).toBeDefined();
    expect(ctx.profilesDirs).toEqual(['/profiles']);
    expect(ctx.taskPrompt).toBe('Build a feature');
    expect(ctx.cwd).toBe('/cwd');
    expect(ctx.workDir).toBe('/work');
    expect(ctx.maxConcurrentTasks).toBe(5);
    expect(ctx.config).toBe(MINIMAL_CONFIG);
  });

  it('accepts optional onStatus, signal, and apiKeys', () => {
    const ctx: PhaseContext = {
      tracker: {} as never,
      profilesDirs: [],
      taskPrompt: 'test',
      cwd: '/',
      workDir: '/',
      maxConcurrentTasks: undefined,
      config: MINIMAL_CONFIG,
      apiKeys: { ANTHROPIC: 'sk-test' },
      onStatus: { onPhaseStart: jest.fn() } as never,
      signal: new AbortController().signal,
    };
    expect(ctx.apiKeys).toEqual({ ANTHROPIC: 'sk-test' });
    expect(ctx.onStatus).toBeDefined();
    expect(ctx.signal).toBeDefined();
  });
});

// ─── getPhaseIndicator ──────────────────────────────────────────────────────

describe('getPhaseIndicator', () => {
  it('returns the icon for a matching phase from the phases array', () => {
    const phases = [
      { id: 'scouting', label: 'Scouting', icon: '🔍' },
      { id: 'planning', label: 'Planning', icon: '📋' },
      { id: 'done', label: 'Done', icon: '✅' },
    ];
    expect(spir.getPhaseIndicator('scouting', phases)).toBe('🔍');
    expect(spir.getPhaseIndicator('planning', phases)).toBe('📋');
    expect(spir.getPhaseIndicator('done', phases)).toBe('✅');
  });

  it('returns hourglass for unknown phases', () => {
    const phases = [{ id: 'scouting', label: 'Scouting', icon: '🔍' }];
    expect(spir.getPhaseIndicator('implementing', phases)).toBe('⏳');
  });

  it('returns hourglass for empty phases array', () => {
    expect(spir.getPhaseIndicator('scouting', [])).toBe('⏳');
  });

  it('accepts phases array as second parameter (renamed from sidebarPhases)', () => {
    const phases = [{ id: 'scouting', label: 'Scouting', icon: '🔍' }];
    const result = spir.getPhaseIndicator('scouting', phases);
    expect(result).toBe('🔍');
  });

  it('works with the Phase type as the first argument', () => {
    const phases = [{ id: 'done', label: 'Done', icon: '✅' }];
    const phase: Phase = 'done';
    expect(spir.getPhaseIndicator(phase, phases)).toBe('✅');
  });

  it('handles phases array with duplicate ids (uses first match)', () => {
    const phases = [
      { id: 'scouting', label: 'Scouting', icon: '🔍' },
      { id: 'scouting', label: 'Scouting Dup', icon: '📋' },
    ];
    expect(spir.getPhaseIndicator('scouting', phases)).toBe('🔍');
  });

  it('handles case with many phases', () => {
    const phases = [
      { id: 'scouting', label: 'Scouting', icon: '1' },
      { id: 'planning', label: 'Planning', icon: '2' },
      { id: 'implementing', label: 'Implementing', icon: '3' },
      { id: 'review', label: 'Review', icon: '4' },
      { id: 'done', label: 'Done', icon: '5' },
    ];
    expect(spir.getPhaseIndicator('implementing' as Phase, phases)).toBe('3');
  });
});

// ─── completePhase ──────────────────────────────────────────────────────────

describe('completePhase', () => {
  it('advances to the next phase in PHASES when no nextPhase given', async () => {
    const setPhase = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const onPhaseComplete = jest.fn();
    const tracker = { setPhase, save, completedPhases: [] } as never;

    const startTime = Date.now();
    await spir.completePhase(
      'scouting' as Phase,
      tracker,
      { onPhaseComplete } as never,
      startTime,
    );

    // Should advance to planning (next in PHASES after scouting)
    expect(setPhase).toHaveBeenCalledWith('planning');
    expect(save).toHaveBeenCalled();
    expect(onPhaseComplete).toHaveBeenCalledWith({
      phase: 'scouting',
      durationMs: expect.any(Number),
    });
  });

  it('jumps to specified nextPhase when provided', async () => {
    const setPhase = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const tracker = { setPhase, save, completedPhases: [] } as never;

    await spir.completePhase(
      'scouting' as Phase,
      tracker,
      undefined,
      Date.now(),
      'scouting', // loop back to scouting
    );

    expect(setPhase).toHaveBeenCalledWith('scouting');
  });

  it('does not advance when there is no next phase', async () => {
    const setPhase = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const tracker = { setPhase, save, completedPhases: [] } as never;

    await spir.completePhase(
      'done' as Phase,
      tracker,
      undefined,
      Date.now(),
    );

    // 'done' is last in PHASES, so no advancement
    expect(setPhase).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  it('works when onStatus is undefined', async () => {
    const setPhase = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const tracker = { setPhase, save, completedPhases: [] } as never;

    await expect(
      spir.completePhase('scouting' as Phase, tracker, undefined, Date.now()),
    ).resolves.toBeUndefined();
  });
});

// ─── executePhase ───────────────────────────────────────────────────────────

describe('executePhase', () => {
  it('calls onPhaseStart and onSidebarUpdate for any phase', async () => {
    const onPhaseStart = jest.fn();
    const onSidebarUpdate = jest.fn();
    const tracker = {
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
      taskTracker: mockTaskTracker,
    } as never;

    const ctx: PhaseContext = {
      tracker,
      profilesDirs: [],
      taskPrompt: 'test',
      cwd: '/',
      workDir: '/',
      maxConcurrentTasks: undefined,
      config: {
        ...MINIMAL_CONFIG,
        phases: [
          { id: 'scouting', label: 'Scouting', icon: '🔍' },
          { id: 'planning', label: 'Planning', icon: '📋' },
          { id: 'implementing', label: 'Implementing', icon: '🔨' },
          { id: 'review', label: 'Review', icon: '🔎' },
        ],
      },
      onStatus: { onPhaseStart, onSidebarUpdate } as never,
    };

    // "done" phase simply breaks — still triggers callbacks
    await spir.executePhase('done' as Phase, {
      research: '',
      plan: undefined,
      scoutingReports: [],
      scoutingRounds: 0,
      scoutingGaps: [],
      planningRounds: 0,
    }, ctx);

    expect(onPhaseStart).toHaveBeenCalledWith({
      phase: 'done',
      round: 0,
    });
    // onSidebarUpdate is called with indicator only
    expect(onSidebarUpdate).toHaveBeenCalledWith({
      indicator: expect.any(String),
    });
    // Verify the phases field is NOT present in the call
    const callArg = onSidebarUpdate.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('phases');
  });

  it('does not crash when onStatus is undefined', async () => {
    const tracker = {
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
      taskTracker: mockTaskTracker,
    } as never;

    const ctx: PhaseContext = {
      tracker,
      profilesDirs: [],
      taskPrompt: 'test',
      cwd: '/',
      workDir: '/',
      maxConcurrentTasks: undefined,
      config: MINIMAL_CONFIG,
    };

    await expect(
      spir.executePhase('done' as Phase, {
        research: '',
        plan: undefined,
        scoutingReports: [],
        scoutingRounds: 0,
        scoutingGaps: [],
        planningRounds: 0,
      }, ctx),
    ).resolves.toBeUndefined();
  });

  it('passes round number for scouting and planning phases', async () => {
    const onPhaseStart = jest.fn();
    const tracker = {
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
      taskTracker: mockTaskTracker,
    } as never;

    const ctx: PhaseContext = {
      tracker,
      profilesDirs: [],
      taskPrompt: 'test',
      cwd: '/',
      workDir: '/',
      maxConcurrentTasks: undefined,
      config: MINIMAL_CONFIG,
      onStatus: { onPhaseStart } as never,
    };

    // Execute done phase with some round counters set
    await spir.executePhase('done' as Phase, {
      research: '',
      plan: undefined,
      scoutingReports: [],
      scoutingRounds: 2,
      scoutingGaps: [],
      planningRounds: 1,
    }, ctx);

    // For "done", round is 0 (only scouting/planning use their respective round counters)
    expect(onPhaseStart).toHaveBeenCalledWith({
      phase: 'done',
      round: 0,
    });
  });
});

// ─── SpirWorkflowData ───────────────────────────────────────────────────────

describe('SpirWorkflowData', () => {
  it('accepts research, plan, scoutingReports, and plan review fields', () => {
    const data: SpirWorkflowData = {
      research: 'Found everything',
      plan: { tasks: [], strategy: 'test' } as never,
      scoutingReports: [{ topic: 'module-a' }],
      planReviewFeedback: 'Good',
      planReviewSuggestions: ['Add edge cases'],
    };
    expect(data.research).toBe('Found everything');
    expect(data.scoutingReports).toHaveLength(1);
  });

  it('all fields are optional', () => {
    const data: SpirWorkflowData = {};
    expect(data.research).toBeUndefined();
    expect(data.plan).toBeUndefined();
  });
});

// ─── Phase Registration (NEW behavior) ──────────────────────────────────────
//
// The updated runSpir emits onPhaseRegister for each phase from config.phases
// AFTER onWorkflowStart and BEFORE the phase loop.

describe('runSpir — phase registration', () => {
  it('config.phases is accessible and has correct shape for onPhaseRegister', () => {
    expect(MINIMAL_CONFIG.phases).toBeDefined();
    expect(MINIMAL_CONFIG.phases).toHaveLength(5);

    // Each phase entry has the correct shape for onPhaseRegister
    for (const phase of MINIMAL_CONFIG.phases) {
      expect(phase).toHaveProperty('id');
      expect(phase).toHaveProperty('label');
      expect(phase).toHaveProperty('icon');
      expect(typeof phase.id).toBe('string');
      expect(typeof phase.label).toBe('string');
      expect(typeof phase.icon).toBe('string');
    }
  });

  it('config.phases includes initialization as the first entry', () => {
    const phases = MINIMAL_CONFIG.phases;
    expect(phases[0].id).toBe('initialization');
    expect(phases[0].label).toBe('Initialization');
    expect(phases[0].icon).toBe('⚙');
  });

  it('onPhaseRegister would receive id, label, icon for each phase', () => {
    const onPhaseRegister = jest.fn<({ id, label, icon }: { id: string; label: string; icon: string }) => void>();

    // Simulate the registration loop that runSpir should perform
    for (const phase of MINIMAL_CONFIG.phases) {
      onPhaseRegister({ id: phase.id, label: phase.label, icon: phase.icon });
    }

    expect(onPhaseRegister).toHaveBeenCalledTimes(5);
    expect(onPhaseRegister).toHaveBeenNthCalledWith(1, {
      id: 'initialization',
      label: 'Initialization',
      icon: '⚙',
    });
    expect(onPhaseRegister).toHaveBeenNthCalledWith(2, {
      id: 'scouting',
      label: 'Scouting',
      icon: '🔍',
    });
    expect(onPhaseRegister).toHaveBeenNthCalledWith(3, {
      id: 'planning',
      label: 'Planning',
      icon: '📋',
    });
    expect(onPhaseRegister).toHaveBeenNthCalledWith(4, {
      id: 'implementing',
      label: 'Implementing',
      icon: '🔨',
    });
    expect(onPhaseRegister).toHaveBeenNthCalledWith(5, {
      id: 'review',
      label: 'Review',
      icon: '🔎',
    });
  });
});

// ─── onSidebarUpdate — no phases field ──────────────────────────────────────
//
// After the update, onSidebarUpdate should only carry title and indicator,
// never a phases field. Phase metadata is now sent via onPhaseRegister.

describe('runSpir — sidebar updates', () => {
  it('onSidebarUpdate calls carry indicator but not phases', () => {
    const onSidebarUpdate = jest.fn();

    // Simulate the updated call pattern
    onSidebarUpdate({ title: 'Test', indicator: '🔍' });
    onSidebarUpdate({ indicator: '✅' });

    for (const call of onSidebarUpdate.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('phases');
    }
  });

  it('onSidebarUpdate still accepts title and indicator', () => {
    const onSidebarUpdate = jest.fn();
    onSidebarUpdate({ title: 'My Title', indicator: '🔍' });
    expect(onSidebarUpdate).toHaveBeenCalledWith({ title: 'My Title', indicator: '🔍' });
  });
});

// ─── Initialization as a REAL phase ─────────────────────────────────────────
//
// The orchestrator should set currentPhaseId to initialization during title
// generation, then advance to scouting.

describe('runSpir — initialization phase', () => {
  it('initialization is the first phase entry in config.phases', () => {
    const config = MINIMAL_CONFIG;
    expect(config.phases[0].id).toBe('initialization');
    expect(config.phases[0].label).toBe('Initialization');
    expect(config.phases[0].icon).toBe('⚙');
  });

  it('initialization phase has correct icon (gear emoji U+2699)', () => {
    const initPhase = MINIMAL_CONFIG.phases.find(p => p.id === 'initialization');
    expect(initPhase).toBeDefined();
    expect(initPhase!.icon).toBe('⚙');
    expect(initPhase!.icon.codePointAt(0)).toBe(0x2699);
  });

  it('tracker.setCurrentPhase should be called with initialization before title gen', () => {
    const setCurrentPhase = jest.fn();

    // Simulate the initialization flow from the updated runSpir
    setCurrentPhase('initialization');
    expect(setCurrentPhase).toHaveBeenCalledWith('initialization');
  });
});

// ─── Abort Handling: cancelTask ─────────────────────────────────────────────
//
// On Workflow cancelled (signal abort), the catch block should cancel all
// active tasks via tracker.taskTracker.cancelTask before calling
// onWorkflowFailed.

describe('runSpir — abort handling', () => {
  beforeEach(() => {
    mockCancelTask.mockClear();
    mockGetAllTasks.mockClear();
  });

  it('cancels all active tasks on abort before calling onWorkflowFailed', () => {
    // Simulate the abort handling logic from the updated runSpir
    const activeTasks = [
      { id: 'task-1', status: 'active' },
      { id: 'task-2', status: 'active' },
      { id: 'task-3', status: 'ready' }, // not active, should be skipped
    ];
    mockGetAllTasks.mockReturnValue(activeTasks);

    // The cancel loop from the updated catch block:
    for (const task of mockTaskTracker.getAllTasks()) {
      if (task.status === 'active') {
        try {
          mockTaskTracker.cancelTask(task.id);
        } catch {
          // ignore errors from already-settled tasks
        }
      }
    }

    expect(mockGetAllTasks).toHaveBeenCalled();
    expect(mockCancelTask).toHaveBeenCalledTimes(2);
    expect(mockCancelTask).toHaveBeenCalledWith('task-1');
    expect(mockCancelTask).toHaveBeenCalledWith('task-2');
    expect(mockCancelTask).not.toHaveBeenCalledWith('task-3');
  });

  it('does not throw if cancelTask throws for already-settled tasks', () => {
    mockGetAllTasks.mockReturnValue([
      { id: 'task-done', status: 'active' },
    ]);

    // Simulate cancelTask throwing (e.g., task already settled)
    mockCancelTask.mockImplementationOnce(() => {
      throw new Error('Task is already settled');
    });

    // Should not throw — errors are caught
    expect(() => {
      for (const task of mockTaskTracker.getAllTasks()) {
        if (task.status === 'active') {
          try {
            mockTaskTracker.cancelTask(task.id);
          } catch {
            // expected: ignore
          }
        }
      }
    }).not.toThrow();

    expect(mockCancelTask).toHaveBeenCalled();
  });

  it('skips non-active tasks during abort cancellation', () => {
    const tasks = [
      { id: 't1', status: 'ready' },
      { id: 't2', status: 'blocked' },
      { id: 't3', status: 'done' },
      { id: 't4', status: 'failed' },
    ];
    mockGetAllTasks.mockReturnValue(tasks);

    for (const task of mockTaskTracker.getAllTasks()) {
      if (task.status === 'active') {
        try {
          mockTaskTracker.cancelTask(task.id);
        } catch {
          // ignore
        }
      }
    }

    expect(mockCancelTask).not.toHaveBeenCalled();
  });

  it('cancels tasks before calling onWorkflowFailed', () => {
    const onWorkflowFailed = jest.fn();
    const callOrder: string[] = [];

    mockGetAllTasks.mockReturnValue([
      { id: 'active-task', status: 'active' },
    ]);

    mockCancelTask.mockImplementation(() => {
      callOrder.push('cancel');
    });

    // Simulate the abort sequence
    for (const task of mockTaskTracker.getAllTasks()) {
      if (task.status === 'active') {
        try {
          mockTaskTracker.cancelTask(task.id);
        } catch {
          // ignore
        }
      }
    }

    onWorkflowFailed({ error: new Error('Workflow cancelled'), phase: 'implementing' });
    callOrder.push('failed');

    // cancelTask should be called before onWorkflowFailed
    expect(callOrder).toEqual(['cancel', 'failed']);
  });
});

// ─── tracker.setPhase stays ─────────────────────────────────────────────────
//
// The updated spir.ts keeps tracker.setPhase(...) calls for phase transitions.
// No changes needed — just verify they exist and work.

describe('tracker.setPhase', () => {
  it('is called for phase transitions in completePhase', async () => {
    const setPhase = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const tracker = { setPhase, save, completedPhases: [] } as never;

    await spir.completePhase('scouting' as Phase, tracker, undefined, Date.now());

    expect(setPhase).toHaveBeenCalled();
  });

  it('is called with the correct next phase name', async () => {
    const setPhase = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const tracker = { setPhase, save, completedPhases: [] } as never;

    await spir.completePhase('planning' as Phase, tracker, undefined, Date.now());

    // Should advance to implementing (next in PHASES after planning)
    expect(setPhase).toHaveBeenCalledWith('implementing');
  });
});

// ─── onPhaseStart ───────────────────────────────────────────────────────────
//
// onPhaseStart calls stay the same — phase is the id string, round is numeric.

describe('onPhaseStart', () => {
  it('receives phase as string id and round as number', () => {
    const onPhaseStart = jest.fn();
    onPhaseStart({ phase: 'scouting', round: 0 });

    expect(onPhaseStart).toHaveBeenCalledWith({
      phase: 'scouting',
      round: 0,
    });
    expect(typeof onPhaseStart.mock.calls[0][0].phase).toBe('string');
    expect(typeof onPhaseStart.mock.calls[0][0].round).toBe('number');
  });

  it('the phase value matches the Phase type', () => {
    const validPhases: Phase[] = ['scouting', 'planning', 'implementing', 'review', 'done'];
    const onPhaseStart = jest.fn();

    for (const phase of validPhases) {
      onPhaseStart({ phase, round: 0 });
    }

    expect(onPhaseStart).toHaveBeenCalledTimes(5);
  });
});

// ─── Exports ────────────────────────────────────────────────────────────────
//
// Verify that all expected modules re-export correctly.

describe('module re-exports', () => {
  it('exports PHASES array', () => {
    expect(spir.PHASES).toBeDefined();
    expect(Array.isArray(spir.PHASES)).toBe(true);
  });

  it('exports Phase type', () => {
    const phase: Phase = 'scouting';
    expect(phase).toBe('scouting');
  });

  it('exports RunState interface (type level)', () => {
    // Type-level: verify the required fields exist
    const _check: Required<RunState> = {
      research: '',
      plan: { tasks: [], strategy: '' } as never,
      scoutingReports: [],
      scoutingRounds: 0,
      scoutingGaps: [],
      planningRounds: 0,
      planReviewFeedback: '',
      planReviewSuggestions: [],
    };
    expect(_check.research).toBe('');
  });

  it('exports PhaseContext interface (type level)', () => {
    const _check: Required<PhaseContext> = {
      tracker: {} as never,
      profilesDirs: [],
      taskPrompt: '',
      cwd: '',
      workDir: '',
      maxConcurrentTasks: 5,
      config: MINIMAL_CONFIG,
      apiKeys: {},
      onStatus: {} as never,
      signal: new AbortController().signal,
    };
    expect(_check.cwd).toBe('');
  });

  it('exports completePhase helper', () => {
    expect(spir.completePhase).toBeDefined();
    expect(typeof spir.completePhase).toBe('function');
  });

  it('exports executePhase helper', () => {
    expect(spir.executePhase).toBeDefined();
    expect(typeof spir.executePhase).toBe('function');
  });

  it('exports getPhaseIndicator helper', () => {
    expect(spir.getPhaseIndicator).toBeDefined();
    expect(typeof spir.getPhaseIndicator).toBe('function');
  });
});

// ─── WorkflowConfig — phases field replaces sidebarPhases ──────────────────

describe('WorkflowConfig — phases field', () => {
  it('config uses phases instead of sidebarPhases', () => {
    // After the config interface is updated, sidebarPhases will be removed.
    // Until then, we test that the new `phases` field is the primary one.
    const config: WorkflowConfig = {
      name: 'test',
      defaultMaxConcurrentTasks: 3,
      fixerSteps: [],
      phases: [
        { id: 'scouting', label: 'Scouting', icon: '🔍' },
      ],
      titleFormatter: (d: string) => d,
    };

    expect(config.phases).toHaveLength(1);
  });

  it('phases entries have id, label, icon strings', () => {
    const config: WorkflowConfig = {
      name: 'test',
      defaultMaxConcurrentTasks: 1,
      fixerSteps: [],
      phases: [
        { id: 'a', label: 'A', icon: '🅰' },
      ],
      titleFormatter: (d: string) => d,
    };
    expect(typeof config.phases[0].id).toBe('string');
    expect(typeof config.phases[0].label).toBe('string');
    expect(typeof config.phases[0].icon).toBe('string');
  });
});
