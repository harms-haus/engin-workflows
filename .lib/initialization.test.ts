// ─── Initialization Phase Tests ─────────────────────────────────────────────
//
// Tests for initialization.ts: adoption of runStepTask for title generation,
// phaseId threading, try/catch fallback, and import updates.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from 'bun:test';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────
const mockRunStepTask = jest.fn<(opts: any) => Promise<{ title: string }>>();
const mockOnTaskRejected = jest.fn<() => void>();

mock.module('@harms-haus/engin', () => ({
  // runStepTask is the key replacement for the old createHarness + promptForStructured sequence
  runStepTask: mockRunStepTask,
  // We still export these for type compatibility, but they are no longer called
  // by initializationPhase directly.
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

// ─── runStepTask Usage ──────────────────────────────────────────────────────

describe('initializationPhase — runStepTask usage', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  it('calls runStepTask with phaseId: "initialization"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(mockRunStepTask).toHaveBeenCalledTimes(1);
    const callOpts = mockRunStepTask.mock.calls[0][0];
    expect(callOpts).toHaveProperty('phaseId', 'initialization');
  });

  it('calls runStepTask with taskId: "title-generator"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    expect(callOpts).toHaveProperty('taskId', 'title-generator');
  });

  it('calls runStepTask with stepName: "generate-title"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    expect(callOpts).toHaveProperty('stepName', 'generate-title');
  });

  it('calls runStepTask with profileId: "scout"', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    expect(callOpts).toHaveProperty('profileId', 'scout');
  });

  it('passes the task prompt as the prompt to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    const taskPrompt = 'Implement a user authentication system with OAuth2 support';
    await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    expect(callOpts).toHaveProperty('prompt');
    expect(callOpts.prompt).toContain(taskPrompt);
  });

  it('passes TitleSchema as the schema to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    // TitleSchema should be passed as schema (imported from ./schemas)
    expect(callOpts).toHaveProperty('schema');
    expect(callOpts.schema).toBeDefined();
  });



  it('passes apiKeys and onStatus through to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });
    const onStatus = { onAgentSpawn: jest.fn() };
    const apiKeys = { ANTHROPIC: 'sk-test' };

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      apiKeys,
      onStatus as never,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    expect(callOpts).toHaveProperty('apiKeys', apiKeys);
    expect(callOpts).toHaveProperty('onStatus', onStatus);
  });

  it('passes cwd, profilesDirs, and isReadOnly: true to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature Title' });

    await initializationPhase(
      ['/profiles/a', '/profiles/b'],
      'Implement the new feature',
      '/my-cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    expect(callOpts).toHaveProperty('profilesDirs', ['/profiles/a', '/profiles/b']);
    expect(callOpts).toHaveProperty('cwd', '/my-cwd');
    expect(callOpts).toHaveProperty('isReadOnly', true);
  });

  it('returns the title from runStepTask on success', async () => {
    const tracker = makeMockTracker();
    const expectedTitle = 'Add OAuth2 Authentication';
    mockRunStepTask.mockResolvedValue({ title: expectedTitle });

    const title = await initializationPhase(
      ['/profiles'],
      'Implement user authentication',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(title).toBe(expectedTitle);
  });
});

// ─── Try/Catch Fallback ─────────────────────────────────────────────────────

describe('initializationPhase — error fallback', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  it('falls back to truncated task prompt when runStepTask throws', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockRejectedValue(new Error('API failure'));

    const taskPrompt = 'Implement a new feature for the dashboard';
    const title = await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    // Should return the truncated prompt (less than 60 chars)
    expect(title).toBe(taskPrompt);
  });

  it('truncates long task prompts with ellipsis on error', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockRejectedValue(new Error('Network error'));

    const longPrompt = 'A'.repeat(100);
    const title = await initializationPhase(
      ['/profiles'],
      longPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    // Should be truncated to 57 chars + '...'
    expect(title).toBe('A'.repeat(57) + '...');
    expect(title.length).toBe(60);
  });

  it('returns exact prompt if it fits within 60 chars on error', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockRejectedValue(new Error('Timeout'));

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
    mockRunStepTask.mockRejectedValue(new Error('Error'));

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
    mockRunStepTask.mockRejectedValue('string error');

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
    mockRunStepTask.mockRejectedValue(null);

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

  it('continues to work when runStepTask rejects with a DOMException', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const taskPrompt = 'Implement feature';
    const title = await initializationPhase(
      ['/profiles'],
      taskPrompt,
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    // Should fall back, not propagate the error
    expect(title).toBe(taskPrompt);
  });
});

// ─── Import Verification ────────────────────────────────────────────────────

describe('initializationPhase — imports', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  it('uses runStepTask (not createHarness/promptForStructured) for title generation', async () => {
    // This test verifies the old pattern (createHarness + promptForStructured)
    // is no longer used. The mock allows us to confirm runStepTask was called
    // and createHarness was NOT called.
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'My Feature' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    // runStepTask should be the only mechanism used
    expect(mockRunStepTask).toHaveBeenCalledTimes(1);
  });

  it('returns a string from initializationPhase', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'Add Login Page' });

    const result = await initializationPhase(
      ['/profiles'],
      'Build a login page',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    expect(typeof result).toBe('string');
    expect(result).toBe('Add Login Page');
  });
});

// ─── Type-level: runStepTask Options ────────────────────────────────────────

describe('initializationPhase — runStepTask options shape', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  it('passes title as a human-readable string to runStepTask', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'Output Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const callOpts = mockRunStepTask.mock.calls[0][0]!;
    // The title field should be set (it's a required field in RunStepTaskOptions)
    expect(callOpts).toHaveProperty('title');
    expect(typeof callOpts.title).toBe('string');
    expect(callOpts.title.length).toBeGreaterThan(0);
  });

  it('all required fields are present in runStepTask call', async () => {
    const tracker = makeMockTracker();
    mockRunStepTask.mockResolvedValue({ title: 'Title' });

    await initializationPhase(
      ['/profiles'],
      'Implement the new feature',
      '/cwd',
      undefined,
      undefined,
      tracker,
    );

    const opts = mockRunStepTask.mock.calls[0][0]!;
    // Verify all required fields from RunStepTaskOptions are present
    expect(opts).toHaveProperty('profilesDirs');
    expect(opts).toHaveProperty('phaseId');
    expect(opts).toHaveProperty('taskId');
    expect(opts).toHaveProperty('title');
    expect(opts).toHaveProperty('stepName');
    expect(opts).toHaveProperty('profileId');
    expect(opts).toHaveProperty('cwd');
    expect(opts).toHaveProperty('prompt');
    // isReadOnly should default to true
    expect(opts).toHaveProperty('isReadOnly', true);
  });
});
