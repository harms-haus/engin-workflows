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
import { jest } from "bun:test";

/**
 * Build a fresh, complete mock of @harms-haus/engin-engine's runtime export surface.
 * Spread `...createEnginMock()` then add/override file-specific stubs.
 */
export function createEnginMock(): Record<string, unknown> {
  return {
    // ── Pool / tracking constructors (override per-file when asserting) ──
    LanePool: jest.fn(),
    TaskTracker: jest.fn(),

    // ── Phase orchestration + hook registry (spir.ts imports these as values) ──
    PhaseRunner: jest.fn().mockImplementation(() => ({
      run: jest.fn().mockResolvedValue(undefined),
    })),
    createHookRegistry: jest.fn().mockImplementation(() => ({
      register: jest.fn(),
      hasSubscribers: jest.fn().mockReturnValue(false),
      invokeObserve: jest.fn().mockResolvedValue(undefined),
      invokePipeline: jest.fn().mockResolvedValue(undefined),
      invokeFirstWins: jest.fn().mockResolvedValue(undefined),
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
    runStepTask: jest.fn().mockResolvedValue(undefined),

    // ── Session-primitive exports (kb-12: initialization title-gen migration) ──
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
    // singleSession: runner factory that wraps one session under gate.run.
    // Returns a Runner function that, when invoked with a RunnerContext, calls
    // ctx.runSession so that runSingleSessionStructured can capture the
    // structured SessionResult via its wrapped runSession closure.
    singleSession: jest
      .fn()
      .mockImplementation((spec: Record<string, unknown>) =>
        jest.fn().mockImplementation(async (ctx: Record<string, unknown>) => {
          const runSession = ctx.runSession;
          if (typeof runSession !== "function")
            throw new Error(
              "engin-mock.singleSession: ctx.runSession missing — test wiring bug",
            );
          const task = ctx.task as { id?: string } | undefined;
          const id = `${task?.id ?? "test"}/${spec.role}#${spec.attempt ?? 1}`;
          await runSession({
            spec: {
              id,
              profile: spec.profile,
              prompt: spec.prompt,
              ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
              outputMode: spec.outputMode ?? "text",
              ...(spec.isReadOnly !== undefined
                ? { isReadOnly: spec.isReadOnly }
                : {}),
              runnerRole: spec.role,
              attempt: spec.attempt ?? 1,
            },
            sessionBaseDir: ctx.sessionBaseDir,
            cwd: ctx.cwd,
            phaseId: ctx.phaseId,
            agentId: ctx.agentId,
            profiles: ctx.profiles,
            signal: ctx.signal ?? new AbortController().signal,
            activeSessions: ctx.activeSessions ?? new Set(),
          });
          return { status: "completed" };
        }),
      ),

    // reviewRunner: execute→review loop runner (kb-4/kb-13).
    // Returns a mock Runner function by default.
    reviewRunner: jest
      .fn()
      .mockImplementation(
        (_executeSpec: unknown, _reviewSpec: unknown, _options?: unknown) =>
          jest.fn().mockResolvedValue({ status: "completed" }),
      ),
    // linearRunner: sequential combinator for composing runners (kb-4/kb-13).
    linearRunner: jest
      .fn()
      .mockImplementation((_children: unknown[]) =>
        jest.fn().mockResolvedValue({ status: "completed" }),
      ),
    // RunnerPool: replaces LanePool, uses getRunnerForTask instead of getStepsForTask (kb-4/kb-13).
    RunnerPool: jest.fn().mockImplementation(() => ({
      run: jest.fn().mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
    })),
    // DEFAULT_MAX_ROUNDS: shared constant from pool/constants.ts.
    DEFAULT_MAX_ROUNDS: 3,
    runMultiStepTask: jest
      .fn()
      .mockResolvedValue({ results: [], approved: true }),
    getDiff: jest.fn().mockImplementation(() => ""),
    // planning.ts reads/writes the plan artifact via these engine helpers.
    ensureDir: async (_dir: string) => {},
    parseJsonWithRepair: (s: string) => JSON.parse(s),
    schemaToString: (_schema: unknown) => "<schema>",
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
        return "";
      },
      get currentPhaseId() {
        return "";
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
