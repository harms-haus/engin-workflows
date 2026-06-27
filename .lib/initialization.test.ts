// ─── Initialization Phase Tests (kb-12) ───────────────────────────────────
//
// Tests for initialization.ts: out-of-phase gate.run + runSession replacing
// the old runStepTask call for title generation.
//
// Desired flow:
//   1. Build a SessionGate({total:1, perModel:{}})
//   2. Build a SessionSpec (title-gen prompt, outputMode:'structured',
//      schema = TitleSchema, runnerRole:'title-gen', attempt:1)
//   3. Load the scout profile and call gate.run(profile, async () =>
//      runSession({spec, sessionBaseDir, cwd, phaseId, agentId, profiles, ...}))
//   4. Extract title (and branchName) from the structured result
//   5. Return the title string; fall back to truncated prompt on error
//
// The title-gen is a META concern — it runs OUT-OF-PHASE (no RunnerPool,
// no TaskTracker), invisible to the task UI, no worktree.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';
import { createEnginMock } from './engin-mock';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
//
// We mock the engine's full surface via createEnginMock() then override the
// symbols relevant to the title-gen session flow:
//   - runSession:  spy returning a structured SessionResult
//   - SessionGate: spy on constructor + gate.run
//   - runStepTask: spy that MUST NOT be called (asserting the old path is gone)

// Mock gate.run: when called, invoke the callback so the inner runSession is executed.
const mockGateRun = jest.fn<(profile: any, fn: (h: { signal: AbortSignal }) => Promise<unknown>) => Promise<unknown>>();
mockGateRun.mockImplementation(async (_profile, fn) => fn({ signal: new AbortController().signal }));

// Mock SessionGate constructor: track construction and return a gate with the mock .run.
const MockSessionGate = jest.fn<(opts: any) => { run: typeof mockGateRun }>();
(MockSessionGate as unknown as ReturnType<typeof jest.fn>).mockImplementation(() => ({ run: mockGateRun }));

// Mock runSession: tracks calls and returns a structured result by default.
const mockRunSession = jest.fn<(ctx: any) => Promise<{ mode: string; data: Record<string, unknown> }>>();
mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'The Title', branchName: 'the-branch' } });

// Spy on runStepTask — the new code MUST NOT call it.
const mockRunStepTask = jest.fn<(opts: any) => Promise<unknown>>();

mock.module('@harms-haus/engin-engine', () => ({
  ...createEnginMock(),
  // Override with per-test spies
  SessionGate: MockSessionGate,
  runSession: mockRunSession,
  runStepTask: mockRunStepTask,
}));

// Dynamic import to ensure mock is applied first
const { initializationPhase } = await import('./initialization');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockTracker() {
  return {
    recordAgentSpawn: jest.fn(),
    incrementAgentCount: jest.fn(),
    auditLog: {
      append: jest.fn().mockResolvedValue(undefined),
    },
  } as never;
}

// ─── Out-of-phase gate.run + runSession flow (kb-12) ──────────────────────

describe('initializationPhase — out-of-phase gate.run + runSession', () => {
  beforeEach(() => {
    mockRunSession.mockClear();
    mockRunStepTask.mockClear();
    mockGateRun.mockClear();
    (MockSessionGate as unknown as ReturnType<typeof jest.fn>).mockClear();
  });

  // ── 1. SessionGate construction ─────────────────────────────────────────

  it('constructs a SessionGate with total:1 and perModel:{}', async () => {
    const tracker = makeMockTracker();
    // Give runSession the default resolved value
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow — old code may throw; we only care about the construction assertion
    }

    expect(MockSessionGate).toHaveBeenCalledWith({ total: 1, perModel: {} });
  });

  it('calls gate.run with a resolved profile for the title-gen agent', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    // gate.run must have been called at least once
    expect(mockGateRun).toHaveBeenCalled();
    // The first argument is the resolved AgentProfile — should have provider and model
    const profileArg = mockGateRun.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (profileArg) {
      expect(profileArg).toHaveProperty('provider');
      expect(profileArg).toHaveProperty('model');
    }
  });

  // ── 2. runSession is called (not runStepTask) ───────────────────────────

  it('calls runSession for title generation (new path)', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    // runSession MUST be called (new path)
    expect(mockRunSession).toHaveBeenCalled();
  });

  it('does NOT call runStepTask (old path removed)', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    // runStepTask MUST NOT be called — the old runStepTask path is removed
    expect(mockRunStepTask).not.toHaveBeenCalled();
  });

  // ── 3. SessionSpec properties ───────────────────────────────────────────

  it('passes a SessionSpec with runnerRole:"title-gen" to runSession', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    const spec = ctx!.spec as Record<string, unknown>;
    expect(spec.runnerRole).toBe('title-gen');
  });

  it('passes a SessionSpec with attempt:1', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const spec = ctx!.spec as Record<string, unknown>;
    expect(spec.attempt).toBe(1);
  });

  it('passes a SessionSpec with outputMode:"structured"', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const spec = ctx!.spec as Record<string, unknown>;
    expect(spec.outputMode).toBe('structured');
  });

  it('passes a schema (TitleSchema or similar) in the SessionSpec', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const spec = ctx!.spec as Record<string, unknown>;
    expect(spec).toHaveProperty('schema');
    expect(spec.schema).toBeDefined();
  });

  it('includes the task prompt in the SessionSpec prompt', async () => {
    const tracker = makeMockTracker();
    const taskPrompt = 'Implement user authentication with OAuth2';
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        taskPrompt,
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const spec = ctx!.spec as Record<string, unknown>;
    expect(spec.prompt).toContain(taskPrompt);
  });

  it('sets isReadOnly:true in the SessionSpec (title-gen is meta, no edits)', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const spec = ctx!.spec as Record<string, unknown>;
    expect(spec.isReadOnly).toBe(true);
  });

  // ── 4. Return value ────────────────────────────────────────────────────

  it('returns the title from the structured SessionResult data on success', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'The Title', branchName: 'the-branch' } });

    // With the new flow, initializationPhase should return 'The Title'
    // (old code uses runStepTask which resolves undefined → fallback → wrong title)
    const title = await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe('The Title');
  });

  // ── 5. Context threading ────────────────────────────────────────────────

  it('threads apiKeys into the runSession context', async () => {
    const tracker = makeMockTracker();
    const apiKeys = { ANTHROPIC: 'sk-test' };
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        apiKeys,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.apiKeys).toEqual(apiKeys);
  });

  it('threads onStatus into the runSession context', async () => {
    const tracker = makeMockTracker();
    const onStatus = { onAgentSpawn: jest.fn() };
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        onStatus as never,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.onStatus).toBe(onStatus);
  });

  it('passes cwd to the runSession context', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles/a', '/profiles/b'],
        'Test task',
        '/my-cwd',
        undefined,
        undefined,
        tracker,
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.cwd).toBe('/my-cwd');
  });

  it('uses workDir to derive sessionBaseDir in the runSession context', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'X', branchName: 'y' } });

    try {
      await initializationPhase(
        ['/profiles'],
        'Test task',
        '/cwd',
        undefined,
        undefined,
        tracker,
        '/some/workdir',
      );
    } catch {
      // swallow
    }

    expect(mockRunSession).toHaveBeenCalled();
    const ctx = mockRunSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    // sessionBaseDir should be derived from workDir
    expect(ctx!.sessionBaseDir).toContain('/some/workdir');
  });
});

// ─── Error handling / fallback ─────────────────────────────────────────────

describe('initializationPhase — error fallback', () => {
  beforeEach(() => {
    mockRunSession.mockClear();
    mockRunStepTask.mockClear();
    mockGateRun.mockClear();
    (MockSessionGate as unknown as ReturnType<typeof jest.fn>).mockClear();
  });

  it('falls back to truncated task prompt when runSession throws', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockRejectedValue(new Error('Session failed'));

    const taskPrompt = 'Implement a new feature for the dashboard';
    const title = await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(taskPrompt);
  });

  it('truncates long task prompts with ellipsis on error', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockRejectedValue(new Error('Network error'));

    const longPrompt = 'A'.repeat(100);
    const title = await initializationPhase(
      ['/profiles'],
      longPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe('A'.repeat(57) + '...');
    expect(title.length).toBe(60);
  });

  it('returns exact prompt if it fits within 60 chars on error', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockRejectedValue(new Error('Timeout'));

    const shortPrompt = 'Short task';
    const title = await initializationPhase(
      ['/profiles'],
      shortPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(shortPrompt);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('does not truncate prompts exactly 60 chars on error', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockRejectedValue(new Error('Error'));

    const exactly60 = 'X'.repeat(60);
    const title = await initializationPhase(
      ['/profiles'],
      exactly60,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(exactly60);
    expect(title.length).toBe(60);
  });

  it('handles non-Error throws gracefully', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockRejectedValue('string error');

    const taskPrompt = 'Implement feature';
    const title = await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(taskPrompt);
  });

  it('handles null throws gracefully', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockRejectedValue(null);

    const taskPrompt = 'Implement feature';
    const title = await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(taskPrompt);
  });

  it('handles AbortError gracefully', async () => {
    const tracker = makeMockTracker();
    const abortError = new DOMException('Aborted', 'AbortError');
    mockRunSession.mockRejectedValue(abortError);

    const taskPrompt = 'Implement feature';
    const title = await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(taskPrompt);
  });
});

// ─── Type-level: return type ───────────────────────────────────────────────

describe('initializationPhase — return type', () => {
  beforeEach(() => {
    mockRunSession.mockClear();
    mockRunStepTask.mockClear();
    mockGateRun.mockClear();
    (MockSessionGate as unknown as ReturnType<typeof jest.fn>).mockClear();
  });

  it('returns a string from initializationPhase on success', async () => {
    const tracker = makeMockTracker();
    mockRunSession.mockResolvedValue({ mode: 'structured', data: { title: 'Add Login Page', branchName: 'add-login' } });

    const result = await initializationPhase(
      ['/profiles'],
      'Build a login page',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(typeof result).toBe('string');
  });
});
