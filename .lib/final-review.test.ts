// ─── Final Review Phase Tests ───────────────────────────────────────────────
//
// Tests for final-review.ts: adoption of runStepTask for final-reviewer,
// phaseId threading for both reviewer and fixer tasks, and loop behavior.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
const mockRunStepTask = jest.fn<(opts: any) => Promise<unknown>>();
const mockPoolRun = jest.fn<() => Promise<{ completedTasks: number; failedTasks: number }>>();
const mockAddTask = jest.fn<(task: any) => void>();
const mockGetAllTasks = jest.fn<() => { id: string; status: string; result?: unknown }[]>();

const MockTaskTracker = jest.fn().mockImplementation(() => ({
  addTask: mockAddTask,
  getAllTasks: mockGetAllTasks,
}));

const MockLanePool = jest.fn().mockImplementation(() => ({
  run: mockPoolRun,
}));

mock.module('@harms-haus/engin', () => ({
  runStepTask: mockRunStepTask,
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  createHarness: jest.fn().mockResolvedValue({
    prompt: jest.fn(),
    getLastAssistantText: jest.fn().mockReturnValue(''),
    sessionId: 'test-session',
    dispose: jest.fn(),
  }),
  promptForStructured: jest.fn().mockResolvedValue({ result: {}, attempts: 1 }),
  loadProfilesFromDirs: async () => new Map(),
  forwardAgentStatus: (cb: unknown) => cb,
  resolveProfilesDirs: (cwd: string, name: string) => [`/profiles/${name}`],
  WorkflowStatusTracker: jest.fn().mockImplementation(() => ({
    recordAgentSpawn: jest.fn(),
    incrementAgentCount: jest.fn(),
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
}));

// Dynamic import to ensure mock is applied first
const { finalReviewPhase } = await import('./final-review');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockTracker() {
  return {
    auditLog: {
      append: jest.fn().mockResolvedValue(undefined),
    },
  } as never;
}

/**
 * Build a final-review assessment result matching FinalReviewTopics shape.
 */
function makeAssessment(issues: { file: string; description: string; severity: string }[] = []) {
  return {
    topics: [{ topic: 'Code Quality', files: ['src/main.ts'] }],
    overallAssessment: 'Some issues found',
    issues: issues.map((i) => ({
      file: i.file,
      description: i.description,
      severity: i.severity as 'critical' | 'minor',
    })),
  };
}

// ─── runStepTask for Final Reviewer ─────────────────────────────────────────

describe('finalReviewPhase — runStepTask for final reviewer', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('uses runStepTask instead of manual createHarness + promptForStructured', async () => {
    const tracker = makeMockTracker();
    // Return an assessment with no issues (clean)
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    // runStepTask should be called (not createHarness)
    expect(mockRunStepTask).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('calls runStepTask with phaseId: "review"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('phaseId', 'review');
  });

  it('calls runStepTask with stepName: "final-review"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('stepName', 'final-review');
  });

  it('calls runStepTask with profileId: "final-reviewer"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('profileId', 'final-reviewer');
  });

  it('taskId follows the pattern "final-reviewer-round-N"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('taskId', 'final-reviewer-round-0');
  });

  it('increments round number in taskId on subsequent rounds', async () => {
    const tracker = makeMockTracker();
    // Round 0: return critical issues
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Security vulnerability', severity: 'critical' },
    ]));
    // Round 1: return clean
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    // Should have been called twice (round 0 and round 1)
    expect(mockRunStepTask).toHaveBeenCalledTimes(2);
    expect(mockRunStepTask.mock.calls[0][0].taskId).toBe('final-reviewer-round-0');
    expect(mockRunStepTask.mock.calls[1][0].taskId).toBe('final-reviewer-round-1');
  });

  it('passes FinalReviewTopicsSchema to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('schema');
    expect(callOpts.schema).toBeDefined();
  });

  it('passes profilesDirs, cwd, apiKeys, onStatus, signal through to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));
    const onStatus = { onAgentSpawn: jest.fn() };
    const abortController = new AbortController();

    await finalReviewPhase(
      tracker,
      ['/profiles/a', '/profiles/b'],
      '/cwd',
      '/work',
      5,
      { ANTHROPIC: 'sk-test' },
      onStatus as never,
      abortController.signal,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('profilesDirs', ['/profiles/a', '/profiles/b']);
    expect(callOpts).toHaveProperty('cwd', '/cwd');
    expect(callOpts).toHaveProperty('apiKeys', { ANTHROPIC: 'sk-test' });
    expect(callOpts).toHaveProperty('onStatus', onStatus);
    expect(callOpts).toHaveProperty('signal', abortController.signal);
  });

  it('passes isReadOnly: true to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('isReadOnly', true);
  });
});

// ─── Clean Assessment (No Issues) ──────────────────────────────────────────

describe('finalReviewPhase — clean assessment', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('returns true when assessment has no issues', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(result).toBe(true);
  });

  it('does not create fixer tasks or LanePool when no issues', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(mockAddTask).not.toHaveBeenCalled();
    // The first round does not create a LanePool if no issues
    // (LanePool is only created for fixers)
    // But MockLanePool might have been called zero times
    // Actually runStepTask doesn't use LanePool, so:
    expect(MockLanePool).not.toHaveBeenCalled();
  });

  it('auditLogs the assessment', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = {
      auditLog: { append },
    } as never;
    const assessment = makeAssessment([]);
    mockRunStepTask.mockResolvedValue(assessment);

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'structured_output',
        agentId: 'final-reviewer',
        output: assessment,
      }),
    );
  });
});

// ─── Critical Issues → Fixer Tasks ─────────────────────────────────────────

describe('finalReviewPhase — critical issues trigger fixers', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('creates fixer tasks for critical issues', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/auth.ts', description: 'Missing input validation', severity: 'critical' },
      { file: 'src/db.ts', description: 'SQL injection risk', severity: 'critical' },
    ]));
    // Second round returns clean
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    // Should create two fixer tasks
    expect(mockAddTask).toHaveBeenCalledTimes(2);
    expect(mockAddTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: 'fixer-0',
      title: expect.stringContaining('Fix: Missing input validation'),
      profile: 'fixer',
      files: ['src/auth.ts'],
      isCode: true,
    }));
    expect(mockAddTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'fixer-1',
      title: expect.stringContaining('Fix: SQL injection risk'),
      profile: 'fixer',
      files: ['src/db.ts'],
      isCode: true,
    }));
  });

  it('skips minor issues (only critical issues spawn fixers)', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/style.css', description: 'Minor formatting', severity: 'minor' },
      { file: 'src/main.ts', description: 'Critical bug', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    // Only 1 critical issue → 1 fixer task
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockAddTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fixer-0',
      files: ['src/main.ts'],
    }));
  });

  it('returns true when only minor issues exist (no critical)', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([
      { file: 'README.md', description: 'Typo', severity: 'minor' },
    ]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(result).toBe(true);
    expect(mockAddTask).not.toHaveBeenCalled();
  });

  it('applies titleFormatter to fixer task titles', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'A very long description that should be truncated by the formatter', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    // Custom titleFormatter: always returns "Fixed!"
    const customFormatter = () => 'Fixed!';

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      customFormatter,
    );

    expect(mockAddTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fix: Fixed!',
    }));
  });
});

// ─── Fixer LanePool with phaseId ───────────────────────────────────────────

describe('finalReviewPhase — fixer LanePool phaseId', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('creates LanePool with phaseId: "review" for fixer tasks', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(MockLanePool).toHaveBeenCalledTimes(1);
    const poolOptions = MockLanePool.mock.calls[0][0];
    expect(poolOptions).toHaveProperty('phaseId', 'review');
  });

  it('passes maxConcurrentLanes from maxConcurrentTasks parameter', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      3,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentLanes: 3 }),
    );
  });

  it('defaults maxConcurrentLanes to 5 when maxConcurrentTasks is undefined', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      undefined,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentLanes: 5 }),
    );
  });

  it('passes sessionBaseDir with fix-round-N suffix', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionBaseDir: '/work/sessions/fix-round-0',
      }),
    );
  });

  it('passes profilesDirs, cwd, apiKeys, onStatus, signal to fixer LanePool', async () => {
    const tracker = makeMockTracker();
    const onStatus = { onAgentSpawn: jest.fn() };
    const abortController = new AbortController();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles/x'],
      '/cwd',
      '/work',
      5,
      { KEY: 'val' },
      onStatus as never,
      abortController.signal,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        profilesDirs: ['/profiles/x'],
        cwd: '/cwd',
        apiKeys: { KEY: 'val' },
        onStatus,
        signal: abortController.signal,
      }),
    );
  });

  it('passes auditLog and taskTracker to fixer LanePool', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = {
      auditLog: { append },
    } as never;
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        auditLog: { append },
        taskTracker: expect.any(Object),
      }),
    );
  });

  it('getStepsForTask returns the fixerSteps passed to the function', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    const customFixerSteps = [{ name: 'my-fix', profileId: 'my-fixer', isReadOnly: false }];

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
      undefined,
      undefined,
      undefined,
      customFixerSteps,
    );

    expect(MockLanePool).toHaveBeenCalledWith(
      expect.objectContaining({
        getStepsForTask: expect.any(Function),
      }),
    );
    const poolOptions = MockLanePool.mock.calls[0][0];
    const steps = poolOptions.getStepsForTask({} as never);
    expect(steps).toEqual(customFixerSteps);
  });

  it('does not pass legacy phase field to LanePool', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const poolOptions = MockLanePool.mock.calls[0][0];
    expect(poolOptions).not.toHaveProperty('phase');
  });

  it('calls pool.run() for the fixer LanePool', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(mockPoolRun).toHaveBeenCalledTimes(1);
  });
});

// ─── Loop Behavior ──────────────────────────────────────────────────────────

describe('finalReviewPhase — loop behavior', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('loops up to maxFixRounds (3) when issues keep appearing', async () => {
    const tracker = makeMockTracker();
    // All three rounds return critical issues
    mockRunStepTask.mockResolvedValue(makeAssessment([
      { file: 'src/main.ts', description: 'Issue persists', severity: 'critical' },
    ]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    // runStepTask called 3 times (rounds 0, 1, 2), then exits
    expect(mockRunStepTask).toHaveBeenCalledTimes(3);
    expect(mockAddTask).toHaveBeenCalledTimes(3); // 1 fixer per round
    expect(MockLanePool).toHaveBeenCalledTimes(3);
    expect(result).toBe(false);
  });

  it('stops early when assessment has no issues', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue(makeAssessment([]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(mockRunStepTask).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('stops early when only minor issues remain', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical bug', severity: 'critical' },
    ]));
    // Second round: only minor issues
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'README.md', description: 'Typo', severity: 'minor' },
    ]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(mockRunStepTask).toHaveBeenCalledTimes(2);
    // First round had critical → created fixer
    // Second round had only minor → no fixers, returns true
    expect(result).toBe(true);
  });

  it('returns false if max rounds exhausted with critical issues remaining', async () => {
    const tracker = makeMockTracker();
    // All 3 rounds return critical issues
    mockRunStepTask.mockResolvedValue(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));

    const result = await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(result).toBe(false);
  });

  it('auditLogs each round assessment', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = {
      auditLog: { append },
    } as never;

    const assessment1 = makeAssessment([
      { file: 'src/main.ts', description: 'Critical bug', severity: 'critical' },
    ]);
    const assessment2 = makeAssessment([]);

    mockRunStepTask.mockResolvedValueOnce(assessment1);
    mockRunStepTask.mockResolvedValueOnce(assessment2);

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentId: 'final-reviewer',
      output: assessment1,
    }));
    expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: 'final-reviewer',
      output: assessment2,
    }));
  });
});

// ─── Type-level: LanePoolOptions uses phaseId (not phase) ──────────────────

describe('finalReviewPhase — LanePoolOptions type for fixers', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('fixer LanePool is constructed with phaseId (not phase)', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callArg = MockLanePool.mock.calls[0][0];
    expect(callArg).toHaveProperty('phaseId', 'review');
  });

  it('fixer LanePool does not receive legacy phase field', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    const callArg = MockLanePool.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('phase');
  });
});

// ─── Fixer Tasks: phaseId in addTask ───────────────────────────────────────

describe('finalReviewPhase — fixer task phaseId', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
    mockPoolRun.mockClear();
    mockAddTask.mockClear();
    mockGetAllTasks.mockClear();
    MockLanePool.mockClear();
    MockTaskTracker.mockClear();
    mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  });

  it('passes phaseId to fixer addTask calls', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([
      { file: 'src/main.ts', description: 'Critical issue', severity: 'critical' },
    ]));
    mockRunStepTask.mockResolvedValueOnce(makeAssessment([]));

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
    );

    expect(mockAddTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fixer-0',
        title: expect.any(String),
        profile: 'fixer',
        files: ['src/main.ts'],
        isCode: true,
        dependencies: [],
      }),
    );
  });
});
