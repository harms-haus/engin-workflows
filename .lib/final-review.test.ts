// ─── Final Review Phase Tests ───────────────────────────────────────────────
//
// Tests for final-review.ts: the multi-dimensional review design. Each round
// runs N specialized reviewers IN PARALLEL (default 4: efficiency, code-quality,
// ui-ux, security). Findings rated medium/high/critical ("actionable") spawn
// one fixer task each; low findings and not-applicable reviews do not. After
// fixers settle, reviewers run again — each receiving its OWN complete prior
// history so it does not re-report fixed findings.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';
import type { FinalReviewResult, FinalReviewFinding, FinalReviewSeverity } from './schemas';

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
const { finalReviewPhase, DEFAULT_FINAL_REVIEWERS, isActionableSeverity } = await import('./final-review');
const { FinalReviewResultSchema } = await import('./schemas');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Reviewer dimensions/profiles in the order the default config lists them. */
const DEFAULT_DIMENSIONS = ['efficiency', 'code-quality', 'ui-ux', 'security'] as const;
const DEFAULT_PROFILE_IDS = DEFAULT_DIMENSIONS.map(
  (d) => `${d.replace('ui-ux', 'ui-ux')}-reviewer`.replace('code-quality-reviewer', 'code-quality-reviewer'),
);
const EXPECTED_REVIEWER_COUNT = DEFAULT_FINAL_REVIEWERS.length; // 4

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockTracker() {
  return {
    auditLog: {
      append: jest.fn().mockResolvedValue(undefined),
    },
  } as never;
}

function makeCleanResult(dimension: string): FinalReviewResult {
  return {
    dimension,
    applicable: true,
    notApplicableReason: '',
    summary: 'No issues found',
    findings: [],
  };
}

function makeNotApplicable(dimension: string, reason = 'Not relevant to these changes'): FinalReviewResult {
  return {
    dimension,
    applicable: false,
    notApplicableReason: reason,
    summary: 'Dimension not applicable',
    findings: [],
  };
}

function makeFinding(
  severity: FinalReviewSeverity,
  overrides: Partial<FinalReviewFinding> = {},
): FinalReviewFinding {
  return {
    id: overrides.id ?? `finding-${severity}`,
    severity,
    file: overrides.file ?? 'src/main.ts',
    title: overrides.title ?? `${severity} issue`,
    description: overrides.description ?? 'A problem was found that needs fixing.',
    fixPrompt: overrides.fixPrompt ?? 'Apply the targeted fix to src/main.ts.',
    ...overrides,
  };
}

function makeResultWithFindings(
  dimension: string,
  findings: FinalReviewFinding[],
): FinalReviewResult {
  return {
    dimension,
    applicable: true,
    notApplicableReason: '',
    summary: `${findings.length} finding(s)`,
    findings,
  };
}

/** Set every reviewer (all 4 dimensions) to return clean for every round. */
function allReviewersClean() {
  // runStepTask is called 4× per round; returning a clean result keyed by the
  // requested dimension keeps every reviewer happy regardless of call order.
  mockRunStepTask.mockImplementation(async (opts: any) =>
    makeCleanResult(opts.profileId.replace('-reviewer', '')),
  );
}

beforeEach(() => {
  mockRunStepTask.mockReset();
  mockPoolRun.mockReset();
  mockAddTask.mockReset();
  mockGetAllTasks.mockReset();
  MockLanePool.mockClear();
  MockTaskTracker.mockClear();
  mockPoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
  allReviewersClean();
});

// ─── runStepTask usage ─────────────────────────────────────────────────────

describe('finalReviewPhase — runStepTask usage per reviewer', () => {
  it('runs one runStepTask per reviewer per round (4 for a single clean round)', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockRunStepTask).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT);
  });

  it('uses phaseId: "review", stepName: "final-review", isReadOnly: true', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    for (const call of mockRunStepTask.mock.calls) {
      const opts = call[0];
      expect(opts.phaseId).toBe('review');
      expect(opts.stepName).toBe('final-review');
      expect(opts.isReadOnly).toBe(true);
      expect(opts.schema).toBe(FinalReviewResultSchema);
    }
  });

  it('uses one profileId per default reviewer dimension', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const profileIds = mockRunStepTask.mock.calls.map((c) => c[0].profileId).sort();
    expect(profileIds).toEqual([...DEFAULT_PROFILE_IDS].sort());
  });

  it('taskIds follow the pattern "<profileId>-round-<n>"', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    for (const call of mockRunStepTask.mock.calls) {
      const opts = call[0];
      expect(opts.taskId).toMatch(/^(efficiency|code-quality|ui-ux|security)-reviewer-round-0$/);
      expect(opts.taskId).toBe(`${opts.profileId}-round-0`);
    }
  });

  it('passes profilesDirs, cwd, apiKeys, onStatus, signal through to runStepTask', async () => {
    const tracker = makeMockTracker();
    const onStatus = { onAgentSpawn: jest.fn() };
    const ac = new AbortController();

    await finalReviewPhase(
      tracker,
      ['/profiles/a', '/profiles/b'],
      '/cwd',
      '/work',
      5,
      { ANTHROPIC: 'sk-test' },
      onStatus as never,
      ac.signal,
    );

    for (const call of mockRunStepTask.mock.calls) {
      const opts = call[0];
      expect(opts.profilesDirs).toEqual(['/profiles/a', '/profiles/b']);
      expect(opts.cwd).toBe('/cwd');
      expect(opts.apiKeys).toEqual({ ANTHROPIC: 'sk-test' });
      expect(opts.onStatus).toBe(onStatus);
      expect(opts.signal).toBe(ac.signal);
    }
  });
});

// ─── Clean Assessment ──────────────────────────────────────────────────────

describe('finalReviewPhase — clean assessment', () => {
  it('returns true when all reviewers are clean', async () => {
    const tracker = makeMockTracker();
    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);
    expect(result).toBe(true);
  });

  it('does not create fixer tasks or a LanePool when clean', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(MockLanePool).not.toHaveBeenCalled();
    expect(mockPoolRun).not.toHaveBeenCalled();
  });

  it('auditLogs each reviewer result (4 events for one round)', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(append).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT);
    for (const call of append.mock.calls) {
      const event = call[0];
      expect(event.type).toBe('structured_output');
      expect(event.output).toBeDefined();
      expect(event.output.findings).toEqual([]);
    }
  });
});

// ─── Actionable findings → fixers ──────────────────────────────────────────

describe('finalReviewPhase — actionable findings spawn fixers', () => {
  it('creates one fixer task per medium/high/critical finding', async () => {
    const tracker = makeMockTracker();
    // Only the efficiency reviewer returns findings; the other three are clean.
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [
        makeFinding('medium', { id: 'm1', title: 'medium issue' }),
        makeFinding('high', { id: 'h1', title: 'high issue' }),
        makeFinding('critical', { id: 'c1', title: 'critical issue' }),
      ]),
    );
    // round 1: clean (default impl returns clean for all)

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).toHaveBeenCalledTimes(3);
    const titles = mockAddTask.mock.calls.map((c) => c[0].title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Fix [medium]: medium issue',
        'Fix [high]: high issue',
        'Fix [critical]: critical issue',
      ]),
    );
  });

  it('does NOT spawn a fixer for low-severity findings', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('low', { title: 'nit' })]),
    );

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    // low is not actionable → no fixers → clean
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('ignores findings from reviews marked not-applicable', async () => {
    const tracker = makeMockTracker();
    // security reviewer says not-applicable but (incorrectly) includes a finding
    mockRunStepTask.mockImplementationOnce(async () => ({
      ...makeResultWithFindings('security', [makeFinding('critical')]),
      applicable: false,
      notApplicableReason: 'No security surface',
    }));

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('builds the fixer prompt from the finding and embeds fixPrompt', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [
        makeFinding('critical', {
          file: 'src/db.ts:10-20',
          title: 'N+1 query',
          description: 'Query runs inside a loop.',
          fixPrompt: 'Batch the query outside the loop.',
        }),
      ]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    const task = mockAddTask.mock.calls[0][0];
    expect(task.profile).toBe('fixer');
    expect(task.isCode).toBe(true);
    expect(task.dependencies).toEqual([]);
    expect(task.phaseId).toBe('review');
    // file line-range stripped for the `files` array
    expect(task.files).toEqual(['src/db.ts']);
    // prompt carries the finding + fixPrompt
    expect(task.prompt).toContain('Efficiency');
    expect(task.prompt).toContain('critical');
    expect(task.prompt).toContain('src/db.ts:10-20');
    expect(task.prompt).toContain('N+1 query');
    expect(task.prompt).toContain('Query runs inside a loop.');
    expect(task.prompt).toContain('Batch the query outside the loop.');
  });

  it('applies titleFormatter to the finding title', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('high', { title: 'slow loop' })]),
    );

    await finalReviewPhase(
      tracker,
      ['/profiles'],
      '/cwd',
      '/work',
      5,
      undefined,
      undefined,
      undefined,
      undefined, // finalReviewers (default)
      undefined, // fixerSteps (default)
      () => 'TRUNC',
    );

    expect(mockAddTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fix [high]: TRUNC' }),
    );
  });
});

// ─── Fixer LanePool options ────────────────────────────────────────────────

describe('finalReviewPhase — fixer LanePool', () => {
  it('creates a LanePool with phaseId "review" and the resolved maxConcurrentLanes', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 3);

    expect(MockLanePool).toHaveBeenCalledTimes(1);
    expect(MockLanePool.mock.calls[0][0]).toMatchObject({
      phaseId: 'review',
      maxConcurrentLanes: 3,
      sessionBaseDir: '/work/sessions/fix-round-0',
      cwd: '/cwd',
      profilesDirs: ['/profiles'],
    });
  });

  it('defaults maxConcurrentLanes to 5 when maxConcurrentTasks is undefined', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', undefined);

    expect(MockLanePool.mock.calls[0][0].maxConcurrentLanes).toBe(5);
  });

  it('passes fixerSteps via getStepsForTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );
    const customSteps = [{ name: 'my-fix', profileId: 'my-fixer', isReadOnly: false }];

    await finalReviewPhase(
      tracker, ['/profiles'], '/cwd', '/work', 5,
      undefined, undefined, undefined,
      undefined, // finalReviewers
      customSteps,
    );

    const poolOpts = MockLanePool.mock.calls[0][0];
    expect(poolOpts.getStepsForTask).toEqual(expect.any(Function));
    expect(poolOpts.getStepsForTask({})).toEqual(customSteps);
  });

  it('does not pass a legacy "phase" field to LanePool', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(MockLanePool.mock.calls[0][0]).not.toHaveProperty('phase');
  });

  it('passes auditLog + a taskTracker to the LanePool and runs it', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const poolOpts = MockLanePool.mock.calls[0][0];
    expect(poolOpts.auditLog).toEqual({ append });
    expect(poolOpts.taskTracker).toBeDefined();
    expect(mockPoolRun).toHaveBeenCalledTimes(1);
  });
});

// ─── Loop Behavior ──────────────────────────────────────────────────────────

describe('finalReviewPhase — loop behavior', () => {
  it('stops after one clean round (4 calls, returns true)', async () => {
    const tracker = makeMockTracker();
    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockRunStepTask).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT);
    expect(result).toBe(true);
  });

  it('re-runs all reviewers after fixers and stops when clean (8 calls)', async () => {
    const tracker = makeMockTracker();
    // Round 0: efficiency has a critical finding; others clean
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );
    // Round 1: all clean (default impl)

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockRunStepTask).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT * 2);
    expect(MockLanePool).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('loops up to 3 rounds (12 calls) and returns false when issues persist', async () => {
    const tracker = makeMockTracker();
    // Every reviewer every round returns a critical finding.
    mockRunStepTask.mockImplementation(async (opts: any) =>
      makeResultWithFindings(opts.profileId.replace('-reviewer', ''), [makeFinding('critical')]),
    );

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockRunStepTask).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT * 3);
    expect(MockLanePool).toHaveBeenCalledTimes(3);
    expect(result).toBe(false);
  });

  it('auditLogs every reviewer result across all rounds', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical')]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    // 4 (round 0) + 4 (round 1, clean) = 8
    expect(append).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT * 2);
  });
});

// ─── Reviewer history is passed on re-review ───────────────────────────────

describe('finalReviewPhase — passes full prior-round history to reviewers', () => {
  it('round-0 prompts contain NO history; round-1 prompts DO', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementationOnce(async () =>
      makeResultWithFindings('efficiency', [makeFinding('critical', { title: 'round0 issue' })]),
    );

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    // Calls 0..3 = round 0; calls 4..7 = round 1
    const round0Prompts = mockRunStepTask.mock.calls.slice(0, 4).map((c) => c[0].prompt as string);
    const round1Prompts = mockRunStepTask.mock.calls.slice(4, 8).map((c) => c[0].prompt as string);

    for (const p of round0Prompts) expect(p).not.toContain('PRIOR REVIEW HISTORY');
    for (const p of round1Prompts) expect(p).toContain('PRIOR REVIEW HISTORY');

    // The efficiency reviewer's round-1 prompt references its round-0 finding.
    const efficiencyRound1 = mockRunStepTask.mock.calls
      .map((c) => c[0])
      .filter((o) => o.profileId === 'efficiency-reviewer' && o.taskId.endsWith('-round-1'))[0];
    expect(efficiencyRound1.prompt).toContain('round0 issue');
    expect(efficiencyRound1.prompt).toContain('do NOT re-report resolved findings');
  });
});

// ─── Custom reviewer set ───────────────────────────────────────────────────

describe('finalReviewPhase — custom finalReviewers', () => {
  it('runs exactly the supplied reviewers (not the defaults)', async () => {
    const tracker = makeMockTracker();
    const custom = [
      { profileId: 'a-reviewer', dimension: 'a', label: 'A' },
      { profileId: 'b-reviewer', dimension: 'b', label: 'B' },
    ];
    mockRunStepTask.mockImplementation(async (opts: any) => makeCleanResult(opts.profileId.replace('-reviewer', '')));

    await finalReviewPhase(
      tracker, ['/profiles'], '/cwd', '/work', 5,
      undefined, undefined, undefined,
      custom,
    );

    expect(mockRunStepTask).toHaveBeenCalledTimes(2);
    const ids = mockRunStepTask.mock.calls.map((c) => c[0].profileId).sort();
    expect(ids).toEqual(['a-reviewer', 'b-reviewer']);
  });

  it('uses the custom dimension in the result dimension field', async () => {
    const tracker = makeMockTracker();
    const custom = [{ profileId: 'perf', dimension: 'perf', label: 'Perf' }];
    mockRunStepTask.mockImplementation(async () => makeCleanResult('perf'));

    await finalReviewPhase(
      tracker, ['/profiles'], '/cwd', '/work', 5,
      undefined, undefined, undefined, custom,
    );

    expect(mockRunStepTask.mock.calls[0][0].prompt).toContain('Perf');
    expect(mockRunStepTask.mock.calls[0][0].prompt).toContain('"perf"');
  });
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('isActionableSeverity', () => {
  it('returns true for medium, high, critical', () => {
    expect(isActionableSeverity('medium')).toBe(true);
    expect(isActionableSeverity('high')).toBe(true);
    expect(isActionableSeverity('critical')).toBe(true);
  });

  it('returns false for low', () => {
    expect(isActionableSeverity('low')).toBe(false);
  });
});

describe('DEFAULT_FINAL_REVIEWERS', () => {
  it('contains the four expected reviewers', () => {
    const byDim = Object.fromEntries(DEFAULT_FINAL_REVIEWERS.map((r) => [r.dimension, r]));
    expect(Object.keys(byDim).sort()).toEqual(['code-quality', 'efficiency', 'security', 'ui-ux']);
    expect(byDim.efficiency.profileId).toBe('efficiency-reviewer');
    expect(byDim['code-quality'].profileId).toBe('code-quality-reviewer');
    expect(byDim['ui-ux'].profileId).toBe('ui-ux-reviewer');
    expect(byDim.security.profileId).toBe('security-reviewer');
  });
});
