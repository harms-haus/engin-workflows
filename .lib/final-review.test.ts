// ─── Final Review Phase Tests ───────────────────────────────────────────────
//
// Tests for final-review.ts: the per-lane multi-dimensional review design.
// Each reviewer runs as an INDEPENDENT LANE in parallel. A lane executes:
//
//     review (round-0) ──▶ clean? done
//                        └▶ [fixer ──▶ review-fixes (round-N)]*
//                                       (loop while actionable, ≤ MAX_FIX_ROUNDS)
//
// The initial review and the review-fixes pass both use the SAME reviewer
// profile, differing only in stepName ("final-review" vs "final-review-fixes")
// and prompt. A clean initial review skips the fixer + review-fixes entirely.
// Findings rated medium/high/critical ("actionable") spawn one fixer task each
// WITHIN that lane; low findings and not-applicable reviews do not. Each lane
// keeps its own history so a reviewer never re-reports already-fixed items.
//
// Default reviewers (5): efficiency, code-quality, ui-ux, security, documentation.
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
const DEFAULT_DIMENSIONS = ['efficiency', 'code-quality', 'ui-ux', 'security', 'documentation'] as const;
const DEFAULT_PROFILE_IDS = DEFAULT_DIMENSIONS.map((d) => `${d}-reviewer`);
const EXPECTED_REVIEWER_COUNT = DEFAULT_FINAL_REVIEWERS.length; // 5
/** Max fixer attempts per lane (mirrors MAX_FIX_ROUNDS in final-review.ts). */
const MAX_FIX_ROUNDS = 3;

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

/** Derive the reviewer dimension from a profileId ("efficiency-reviewer" → "efficiency"). */
function dimensionOfProfileId(profileId: string): string {
  return profileId.replace(/-reviewer$/, '');
}

/** taskId matcher for ANY reviewer pass (initial review OR review-fixes). */
const isAnyReviewerCall = (taskId: string) =>
  /^(efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId);

/** taskId matcher for the INITIAL review pass only (round-0). */
const isInitialReviewCall = (taskId: string) =>
  /^(efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-0$/.test(taskId);

/** taskId matcher for a review-fixes pass only (round ≥ 1). */
const isReviewFixesCall = (taskId: string) =>
  /^(efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-[1-9]\d*$/.test(taskId);

/**
 * Set every reviewer to return a clean result for EVERY pass (initial + verify).
 * Lanes stay clean from the start, so no fixer / review-fixes passes run.
 */
function allReviewersClean() {
  mockRunStepTask.mockImplementation(async (opts: any) =>
    makeCleanResult(dimensionOfProfileId(opts.profileId)),
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
  it('runs one INITIAL review per reviewer (5 for an all-clean run)', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const initialCalls = mockRunStepTask.mock.calls.filter((c) =>
      isInitialReviewCall(c[0].taskId),
    );
    expect(initialCalls).toHaveLength(EXPECTED_REVIEWER_COUNT);
    // No verify passes ran (all lanes clean on first pass).
    const verifyCalls = mockRunStepTask.mock.calls.filter((c) =>
      isReviewFixesCall(c[0].taskId),
    );
    expect(verifyCalls).toHaveLength(0);
  });

  it('uses phaseId: "review", isReadOnly: true, FinalReviewResultSchema for every pass', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    for (const call of mockRunStepTask.mock.calls) {
      const opts = call[0];
      expect(opts.phaseId).toBe('review');
      expect(opts.isReadOnly).toBe(true);
      expect(opts.schema).toBe(FinalReviewResultSchema);
    }
  });

  it('uses stepName "final-review" for the initial pass and "final-review-fixes" for verify passes', async () => {
    const tracker = makeMockTracker();
    // efficiency reports a finding on round-0, then is clean on every verify pass.
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const initialCalls = mockRunStepTask.mock.calls.filter((c) => isInitialReviewCall(c[0].taskId));
    const verifyCalls = mockRunStepTask.mock.calls.filter((c) => isReviewFixesCall(c[0].taskId));
    expect(initialCalls).toHaveLength(EXPECTED_REVIEWER_COUNT);
    for (const c of initialCalls) expect(c[0].stepName).toBe('final-review');
    // efficiency lane ran exactly one verify pass (round-1, clean).
    expect(verifyCalls).toHaveLength(1);
    for (const c of verifyCalls) {
      expect(c[0].stepName).toBe('final-review-fixes');
      expect(c[0].profileId).toBe('efficiency-reviewer');
    }
  });

  it('uses one profileId per default reviewer dimension', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const profileIds = mockRunStepTask.mock.calls
      .filter((c) => isInitialReviewCall(c[0].taskId))
      .map((c) => c[0].profileId)
      .sort();
    expect(profileIds).toEqual([...DEFAULT_PROFILE_IDS].sort());
  });

  it('initial-review taskIds follow the pattern "<profileId>-round-0"', async () => {
    const tracker = makeMockTracker();
    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    for (const call of mockRunStepTask.mock.calls) {
      const opts = call[0];
      if (!isInitialReviewCall(opts.taskId)) continue;
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

  it('auditLogs each reviewer result (5 events for one clean pass)', async () => {
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

// ─── Actionable findings → fixers (per lane) ───────────────────────────────

describe('finalReviewPhase — actionable findings spawn fixers in that lane', () => {
  it('creates one fixer task per medium/high/critical finding (single dirty lane)', async () => {
    const tracker = makeMockTracker();
    // Only the efficiency reviewer returns findings; the other four are clean.
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [
          makeFinding('medium', { id: 'm1', title: 'medium issue' }),
          makeFinding('high', { id: 'h1', title: 'high issue' }),
          makeFinding('critical', { id: 'c1', title: 'critical issue' }),
        ]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).toHaveBeenCalledTimes(3);
    const titles = mockAddTask.mock.calls.map((c) => c[0].title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Fix [medium] Efficiency: medium issue',
        'Fix [high] Efficiency: high issue',
        'Fix [critical] Efficiency: critical issue',
      ]),
    );
  });

  it('does NOT spawn a fixer for low-severity findings', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('low', { title: 'nit' })]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('ignores findings from reviews marked not-applicable', async () => {
    const tracker = makeMockTracker();
    // security reviewer says not-applicable but (incorrectly) includes a finding
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'security-reviewer-round-0') {
        return {
          ...makeResultWithFindings('security', [makeFinding('critical')]),
          applicable: false,
          notApplicableReason: 'No security surface',
        };
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('builds the fixer prompt from the finding and embeds fixPrompt', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [
          makeFinding('critical', {
            file: 'src/db.ts:10-20',
            title: 'N+1 query',
            description: 'Query runs inside a loop.',
            fixPrompt: 'Batch the query outside the loop.',
          }),
        ]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

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
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('high', { title: 'slow loop' })]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

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
      expect.objectContaining({ title: 'Fix [high] Efficiency: TRUNC' }),
    );
  });
});

// ─── Per-lane fixer LanePool ───────────────────────────────────────────────

describe('finalReviewPhase — per-lane fixer LanePool', () => {
  it('creates one LanePool per dirty lane with phaseId "review" and resolved maxConcurrentLanes', async () => {
    const tracker = makeMockTracker();
    // Two dirty lanes (efficiency + security), each with one finding, both resolve on verify.
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (
        opts.taskId === 'efficiency-reviewer-round-0' ||
        opts.taskId === 'security-reviewer-round-0'
      ) {
        return makeResultWithFindings(dimensionOfProfileId(opts.profileId), [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 3);

    expect(MockLanePool).toHaveBeenCalledTimes(2);
    for (const ctorCall of MockLanePool.mock.calls) {
      expect(ctorCall[0]).toMatchObject({
        phaseId: 'review',
        maxConcurrentLanes: 3,
        cwd: '/cwd',
        profilesDirs: ['/profiles'],
      });
    }
  });

  it('scopes the fixer session dir per dimension + fix round (lanes never collide)', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(MockLanePool).toHaveBeenCalledTimes(1);
    expect(MockLanePool.mock.calls[0][0].sessionBaseDir).toBe('/work/sessions/fix-efficiency-0');
  });

  it('defaults maxConcurrentLanes to 5 when maxConcurrentTasks is undefined', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', undefined);

    expect(MockLanePool.mock.calls[0][0].maxConcurrentLanes).toBe(5);
  });

  it('passes fixerSteps via getStepsForTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });
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
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(MockLanePool.mock.calls[0][0]).not.toHaveProperty('phase');
  });

  it('passes auditLog + a taskTracker to the LanePool and runs it', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const poolOpts = MockLanePool.mock.calls[0][0];
    expect(poolOpts.auditLog).toEqual({ append });
    expect(poolOpts.taskTracker).toBeDefined();
    expect(mockPoolRun).toHaveBeenCalledTimes(1);
  });
});

// ─── Per-lane loop behavior ────────────────────────────────────────────────

describe('finalReviewPhase — per-lane loop behavior', () => {
  it('a clean lane does NOT trigger any fixer or review-fixes pass', async () => {
    const tracker = makeMockTracker();
    // Only efficiency is dirty (resolves on verify); the other 4 lanes are clean.
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    // Clean lanes contribute exactly one initial-review call each.
    const cleanLaneProfiles = DEFAULT_PROFILE_IDS.filter((p) => p !== 'efficiency-reviewer');
    for (const profileId of cleanLaneProfiles) {
      const calls = mockRunStepTask.mock.calls.filter(
        (c) => typeof c[0].taskId === 'string' && c[0].taskId.startsWith(`${profileId}-round-`),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0].taskId).toBe(`${profileId}-round-0`);
    }
    // Exactly one LanePool — efficiency's only fix round.
    expect(MockLanePool).toHaveBeenCalledTimes(1);
  });

  it('runs review → fixer → review-fixes for one dirty lane then stops (6 calls, 1 pool)', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(result).toBe(true);
    // 5 initial reviews + 1 efficiency verify pass = 6 reviewer calls total.
    const reviewerCalls = mockRunStepTask.mock.calls.filter((c) => isAnyReviewerCall(c[0].taskId));
    expect(reviewerCalls).toHaveLength(EXPECTED_REVIEWER_COUNT + 1);
    expect(MockLanePool).toHaveBeenCalledTimes(1);
  });

  it('loops fixer → review-fixes within a lane until that lane is clean', async () => {
    const tracker = makeMockTracker();
    // efficiency stays dirty for round-0 and round-1, then clean on round-2.
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.profileId === 'efficiency-reviewer') {
        const round = Number(opts.taskId.match(/-round-(\d+)$/)![1]);
        if (round <= 1) {
          return makeResultWithFindings('efficiency', [makeFinding('critical')]);
        }
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(result).toBe(true);
    // efficiency lane: review(0) + verify(1, dirty) + verify(2, clean) = 3 calls, 2 fixer pools.
    const efficiencyCalls = mockRunStepTask.mock.calls.filter(
      (c) => c[0].profileId === 'efficiency-reviewer',
    );
    expect(efficiencyCalls).toHaveLength(3);
    expect(MockLanePool).toHaveBeenCalledTimes(2);
  });

  it('gives up on a lane after MAX_FIX_ROUNDS and returns false', async () => {
    const tracker = makeMockTracker();
    // efficiency is ALWAYS dirty; others clean.
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.profileId === 'efficiency-reviewer') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(result).toBe(false);
    // efficiency lane: review(0) + 3 verify passes (rounds 1,2,3) = 4 calls, 3 fixer pools.
    const efficiencyCalls = mockRunStepTask.mock.calls.filter(
      (c) => c[0].profileId === 'efficiency-reviewer',
    );
    expect(efficiencyCalls).toHaveLength(1 + MAX_FIX_ROUNDS);
    expect(MockLanePool).toHaveBeenCalledTimes(MAX_FIX_ROUNDS);
    // session dirs are per dimension + fix round: fix-efficiency-0, -1, -2
    const sessionDirs = MockLanePool.mock.calls.map((c) => c[0].sessionBaseDir);
    expect(sessionDirs).toEqual([
      '/work/sessions/fix-efficiency-0',
      '/work/sessions/fix-efficiency-1',
      '/work/sessions/fix-efficiency-2',
    ]);
  });

  it('returns false if ANY lane stays dirty (even if others are clean)', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      // documentation lane never resolves.
      if (opts.profileId === 'documentation-reviewer') {
        return makeResultWithFindings('documentation', [makeFinding('high')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(result).toBe(false);
    // Only the documentation lane spawned fixers.
    expect(MockLanePool).toHaveBeenCalledTimes(MAX_FIX_ROUNDS);
  });

  it('every lane always dirty → 5 lanes × 4 passes = 20 calls, 5 lanes × 3 pools = 15 pools', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) =>
      makeResultWithFindings(dimensionOfProfileId(opts.profileId), [makeFinding('critical')]),
    );

    const result = await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    expect(result).toBe(false);
    const reviewerCalls = mockRunStepTask.mock.calls.filter((c) => isAnyReviewerCall(c[0].taskId));
    expect(reviewerCalls).toHaveLength(EXPECTED_REVIEWER_COUNT * (1 + MAX_FIX_ROUNDS));
    expect(MockLanePool).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT * MAX_FIX_ROUNDS);
  });

  it('auditLogs every reviewer result across all passes (initial + verify)', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const tracker = { auditLog: { append } } as never;
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [makeFinding('critical')]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    // 5 initial reviews + 1 efficiency verify = 6 audit events.
    expect(append).toHaveBeenCalledTimes(EXPECTED_REVIEWER_COUNT + 1);
  });
});

// ─── Reviewer history is passed on re-review ───────────────────────────────

describe('finalReviewPhase — passes full prior-pass history to reviewers', () => {
  it('initial-review prompts contain NO history; verify prompts DO', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockImplementation(async (opts: any) => {
      if (opts.taskId === 'efficiency-reviewer-round-0') {
        return makeResultWithFindings('efficiency', [
          makeFinding('critical', { title: 'round0 issue' }),
        ]);
      }
      return makeCleanResult(dimensionOfProfileId(opts.profileId));
    });

    await finalReviewPhase(tracker, ['/profiles'], '/cwd', '/work', 5);

    const initialCalls = mockRunStepTask.mock.calls.filter((c) => isInitialReviewCall(c[0].taskId));
    const verifyCalls = mockRunStepTask.mock.calls.filter((c) => isReviewFixesCall(c[0].taskId));

    for (const c of initialCalls) expect(c[0].prompt).not.toContain('PRIOR REVIEW HISTORY');
    expect(verifyCalls).toHaveLength(1);
    const verifyPrompt = verifyCalls[0][0].prompt as string;
    expect(verifyPrompt).toContain('PRIOR REVIEW HISTORY');
    // The efficiency reviewer's verify prompt references its round-0 finding.
    expect(verifyPrompt).toContain('round0 issue');
    expect(verifyPrompt).toContain('VERIFY the fixes');
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
    mockRunStepTask.mockImplementation(async (opts: any) =>
      makeCleanResult(opts.profileId.replace(/-reviewer$/, '')),
    );

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
  it('contains the five expected reviewers', () => {
    const byDim = Object.fromEntries(DEFAULT_FINAL_REVIEWERS.map((r) => [r.dimension, r]));
    expect(Object.keys(byDim).sort()).toEqual([
      'code-quality',
      'documentation',
      'efficiency',
      'security',
      'ui-ux',
    ]);
    expect(byDim.efficiency.profileId).toBe('efficiency-reviewer');
    expect(byDim['code-quality'].profileId).toBe('code-quality-reviewer');
    expect(byDim['ui-ux'].profileId).toBe('ui-ux-reviewer');
    expect(byDim.security.profileId).toBe('security-reviewer');
    expect(byDim.documentation.profileId).toBe('documentation-reviewer');
  });
});
