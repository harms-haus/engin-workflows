// ─── Shared @harms-haus/engin-engine mock factory ──────────────────────────────
//
// bun's `mock.module` is process-global: when several test files each register
// a PARTIAL mock of `@harms-haus/engin-engine`, whichever mock bun resolves first wins
// for the ENTIRE test process. Every source file imported during the run then
// resolves its `@harms-haus/engin-engine` imports against that one winning mock — so a
// mock missing a symbol any source imports makes that source fail to load with
// `SyntaxError: Export named 'X' not found`.
//
// This factory returns the COMPLETE runtime export surface with sensible no-op
// defaults. Each test file spreads it and overrides only the symbols it needs
// to assert against (LanePool, TaskTracker, getDiff, …). Call it fresh inside
// every `mock.module` factory so per-file jest.fn() instances stay isolated.
import { jest } from 'bun:test';

/**
 * Build a fresh, complete mock of @harms-haus/engin-engine's runtime export surface.
 * Spread `...createEnginMock()` then add/override file-specific stubs.
 */
export function createEnginMock(): Record<string, unknown> {
  return {
    // ── Pool / tracking constructors (override per-file when asserting) ──
    LanePool: jest.fn(),
    TaskTracker: jest.fn(),

    // ── Value exports used across .lib source files ─────────────────────
    clearTaskSessions: jest.fn(),
    assignSequentialTaskIds: jest.fn(<T extends { id: string; dependencies: string[] }>(tasks: T[]) => tasks),
    resolveProfilesDirs: (_cwd: string, _name: string) => ['/profiles'],
    loadProfilesFromDirs: async () => new Map(),
    forwardAgentStatus: (cb: unknown) => cb,
    runStepTask: jest.fn().mockResolvedValue(undefined),
    runMultiStepTask: jest.fn().mockResolvedValue({ results: [], approved: true }),
    getDiff: () => '',
    // planning.ts reads/writes the plan artifact via these engine helpers.
    ensureDir: async (_dir: string) => {},
    parseJsonWithRepair: (s: string) => JSON.parse(s),
    schemaToString: (_schema: unknown) => '<schema>',
    createHarness: jest.fn().mockResolvedValue({
      prompt: jest.fn().mockResolvedValue(undefined),
      getLastAssistantText: jest.fn().mockReturnValue(''),
      messages: [],
      subscribe: jest.fn().mockReturnValue(jest.fn()),
      sessionId: 'test-session',
      dispose: jest.fn(),
    }),
    promptForStructured: jest.fn().mockResolvedValue({ result: {}, attempts: 1 }),

    // ── WorkflowStatusTracker: rich no-op instance ──────────────────────
    // Sources construct or read many methods/getters; provide a permissive
    // stand-in so any access resolves. Files that assert on specific methods
    // override WorkflowStatusTracker with their own implementation.
    WorkflowStatusTracker: jest.fn().mockImplementation(() => ({
      setPhase: jest.fn(),
      setCurrentPhase: jest.fn(),
      setTaskPrompt: jest.fn(),
      setWorktree: jest.fn(),
      setWorkflowData: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      recordAgentSpawn: jest.fn(),
      incrementAgentCount: jest.fn(),
      get workflowData() {
        return {};
      },
      get currentPhase() {
        return '';
      },
      get currentPhaseId() {
        return '';
      },
      get completedPhases() {
        return [];
      },
      get completedPhaseIds() {
        return [];
      },
      get stats() {
        return { agentCount: 0, totalTokens: 0, totalCost: 0 };
      },
    })),

    // ── Type-only re-exports (erased at runtime; present for completeness) ──
    StatusCallbacks: {},
    StepDefinition: {},
  };
}
