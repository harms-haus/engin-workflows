// ─── Shared @harms-haus/engin-engine mock factory ──────────────────────────────
//
// bun's `mock.module` is process-global: when several test files each register
// a PARTIAL mock of `@harms-haus/engin-engine`, whichever mock bun resolves first wins
// for the ENTIRE test process. Every source file imported during the run then
// resolves its `@harms-haus/engin-engine` imports against that one winning mock — so a
// mock missing a symbol any source imports makes that source fail to load with
// `SyntaxError: Export named 'X' not found`.
//
// This factory returns the COMPLETE runtime export surface of the NEW
// SessionPlan-contract engine with sensible no-op defaults. Each test file
// spreads it and overrides only the symbols it needs to assert against
// (SessionScheduler, TaskGraph, getDiff, …). Call it fresh inside every
// `mock.module` factory so per-file jest.fn() instances stay isolated.
//
// ── Contract migration (kb-27 / E1) ────────────────────────────────────────
//   RunnerPool            → SessionScheduler
//   TaskTracker           → TaskGraph
//   WorkflowStatusTracker → REMOVED (gone from the workflow contract)
//   runSessionViaGate     → runScheduledSession
//   runners (functions)   → SessionPlanRunner objects ({ plan, execute })
import { jest } from "bun:test";

/**
 * Build a fresh SessionPlanRunner-shaped object — the common return value for
 * every runner factory mock. `plan` is an async generator that yields a single
 * batch containing the (optional) spec; `execute` resolves to an empty text
 * SessionResult. Tests override `execute` when they need to assert on it.
 */
function makeSessionPlanRunner(spec?: unknown) {
  return {
    plan: async function* () {
      yield [spec];
    },
    execute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
  };
}

/**
 * Build a fresh, complete mock of @harms-haus/engin-engine's runtime export surface.
 * Spread `...createEnginMock()` then add/override file-specific stubs.
 */
export function createEnginMock(): Record<string, unknown> {
  return {
    // ── Scheduler / graph constructors (override per-file when asserting) ──
    // SessionScheduler: replaces RunnerPool. Runs the task graph through the
    // session gate and resolves with completed/failed task counts.
    SessionScheduler: jest.fn().mockImplementation(() => ({
      run: jest
        .fn()
        .mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
    })),
    // TaskGraph: replaces TaskTracker. Dependency-aware task graph with
    // addTask / getReadyTasks / status transitions.
    TaskGraph: jest.fn().mockImplementation(() => ({
      addTask: jest.fn(),
      addTasks: jest.fn(),
      getTask: jest.fn().mockReturnValue(undefined),
      getAllTasks: jest.fn().mockReturnValue([]),
      getReadyTasks: jest.fn().mockReturnValue([]),
      setTaskStatus: jest.fn(),
      failDeadlockedTasks: jest.fn(),
      transitiveDependentCount: jest.fn().mockReturnValue(0),
      makeNoopRunnerFactory: jest.fn().mockReturnValue(() => makeSessionPlanRunner()),
    })),

    // ── Phase orchestration + hook registry (spir.ts imports these as values) ──
    PhaseRunner: jest.fn().mockImplementation(() => ({
      run: jest.fn().mockResolvedValue(undefined),
    })),
    createHookRegistry: jest.fn().mockImplementation(() => ({
      register: jest.fn(),
      hasSubscribers: jest.fn().mockReturnValue(false),
      invokeObserve: jest.fn().mockResolvedValue(undefined),
      invokePipeline: jest.fn().mockResolvedValue(undefined),
      invokeFirstWin: jest.fn().mockResolvedValue(undefined),
      invokeAllRun: jest.fn().mockResolvedValue(undefined),
    })),

    // ── Value exports used across .lib source files ─────────────────────
    clearTaskSessions: jest.fn(),
    assignSequentialTaskIds: jest.fn(
      <T extends { id: string; dependencies: string[] }>(tasks: T[]) => tasks,
    ),
    resolveProfilesDirs: (_cwd: string, _name: string) => ["/profiles"],
    loadProfilesFromDirs: jest.fn().mockImplementation(async () => new Map()),
    forwardAgentStatus: (cb: unknown) => cb,

    // ── Session-primitive exports ──────────────────────────────────────────
    // SessionGate: two-level FIFO concurrency gate. Default mock invokes the callback.
    SessionGate: jest.fn().mockImplementation(() => ({
      run: jest
        .fn()
        .mockImplementation(
          async (
            _profile: unknown,
            fn: (h: { signal: AbortSignal }) => Promise<unknown>,
          ) => fn({ signal: new AbortController().signal }),
        ),
    })),
    // runSession: single-agent session primitive.
    runSession: jest.fn().mockResolvedValue({ mode: "text", text: "" }),
    // runScheduledSession: replaces runSessionViaGate. Drives one session spec
    // through the gate using a SessionPlanContext.
    runScheduledSession: jest
      .fn()
      .mockResolvedValue({ mode: "text", text: "" }),

    // ── Runner factories — each returns a SessionPlanRunner-shaped object ──
    //
    // The real engine factories return a SessionPlanFactory (() => SessionPlanRunner).
    // For the mock we collapse the indirection: calling the factory yields a
    // SessionPlanRunner directly ({ plan, execute }). Tests that need to assert
    // on execute override the returned runner's execute jest.fn().
    singleSession: jest
      .fn()
      .mockImplementation((spec: Record<string, unknown>) =>
        makeSessionPlanRunner(spec),
      ),
    reviewRunner: jest
      .fn()
      .mockImplementation(
        (_executeSpec: unknown, _reviewSpec: unknown, _options?: unknown) =>
          makeSessionPlanRunner(),
      ),
    linearRunner: jest
      .fn()
      .mockImplementation((_children: unknown[]) => makeSessionPlanRunner()),
    parallelRunner: jest
      .fn()
      .mockImplementation((_children: unknown[]) => makeSessionPlanRunner()),
    councilRunner: jest
      .fn()
      .mockImplementation(
        (_workers: unknown[], _synthesizer: unknown) =>
          makeSessionPlanRunner(),
      ),
    mapRunner: jest
      .fn()
      .mockImplementation((_options: unknown) => makeSessionPlanRunner()),
    branchRunner: jest
      .fn()
      .mockImplementation((_options: unknown) => makeSessionPlanRunner()),
    coordinatorRunner: jest
      .fn()
      .mockImplementation(
        (_coordinatorSpec: unknown, _opts: unknown) =>
          makeSessionPlanRunner(),
      ),
    retrospectiveCouncilRunner: jest
      .fn()
      .mockImplementation(
        (_options: unknown) =>
          makeSessionPlanRunner(),
      ),
    coalescingRunner: jest
      .fn()
      .mockImplementation(
        (_coordinatorSpec: unknown, _opts: unknown) =>
          makeSessionPlanRunner(),
      ),
    // defaultExecute: the shared SessionPlan execute primitive.
    defaultExecute: jest.fn().mockResolvedValue({ mode: "text", text: "" }),

    // DEFAULT_MAX_ROUNDS: shared constant from pool/constants.ts.
    DEFAULT_MAX_ROUNDS: 3,
    getDiff: jest.fn().mockImplementation(() => ""),
    // planning.ts reads/writes the plan artifact via these engine helpers.
    ensureDir: async (_dir: string) => {},
    parseJsonWithRepair: (s: string) => JSON.parse(s),
    schemaToString: (_schema: unknown) => "<schema>",

    // ── EventStore: event-sourced projection store ──────────────────────
    EventStore: jest.fn().mockImplementation(() => ({
      getProjection: () => ({}),
      getEventsSince: () => [],
      append: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      saveSnapshot: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn(),
    })),

    // ── AuditLog (spir.ts constructs one from workDir for createDefaultAuditor) ──
    AuditLog: jest.fn().mockImplementation(() => ({
      append: jest.fn().mockResolvedValue(undefined),
    })),

    // ── Default auditor (spir.ts registers this once against the resolved hookRegistry) ──
    createDefaultAuditor: jest.fn().mockReturnValue({
      onStructuredOutput: jest.fn().mockResolvedValue(undefined),
      onDecision: jest.fn().mockResolvedValue(undefined),
    }),
    createHarness: jest.fn().mockResolvedValue({
      prompt: jest.fn().mockResolvedValue(undefined),
      getLastAssistantText: jest.fn().mockReturnValue(""),
      messages: [],
      subscribe: jest.fn().mockReturnValue(jest.fn()),
      sessionId: "test-session",
      dispose: jest.fn(),
    }),
    promptForStructured: jest
      .fn()
      .mockResolvedValue({ result: {}, attempts: 1 }),

    // ── Type-only re-exports (erased at runtime; present for completeness) ──
    // SessionPlan contract types (supersede the old runner types).
    SessionPlanRunner: {},
    SessionPlanFactory: {},
    SessionPlanContext: {},
    MapRunnerOptions: {},
    CoordinatorRunnerOptions: {},
    CoalescingRunnerOptions: {},
    BranchCondition: {},
    BranchRunnerOptions: {},
    // Surviving shared types referenced by source `import type` declarations.
    StatusCallbacks: {},
    StepDefinition: {},
    WorkflowRunOptions: {},
    AgentProfile: {},
    HarnessCreationOptions: {},
    RendererRegistry: {},
    Runner: {},
    SessionSpec: {},
    RunSessionContext: {},
    SessionResult: {},
    Task: {},
    PhaseDefinition: {},
    AuditEvent: {},
  };
}
