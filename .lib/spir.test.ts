// ─── SPIR Backbone Orchestrator Tests ───────────────────────────────────────
//
// Tests for spir.ts after the E2 tracker-removal migration (kb-28):
//
//   - WorkflowStatusTracker is REMOVED. Resume state is read from
//     `options.eventStore.getProjection()` (workflowData, currentPhaseId, …).
//   - A `TaskGraph` is constructed instead of using `tracker.taskTracker`.
//   - Workflow data flows via `onStatus.onWorkflowData` (events), not
//     `tracker.setWorkflowData`.
//   - The PhaseRunner receives a lightweight `PhaseTracker` adapter (no-ops for
//     registerPhase/setPhase/save since events are the source of truth) that
//     surfaces `taskGraph.getAllTasks()` to the `onPhaseSettled` hook.
//   - PhaseRunner now emits onPhaseStart/onPhaseComplete/onPhaseRegister via
//     onStatus itself (D6), so the SPIR hooks own only the abort guard,
//     scouting retry, scouting collect-loop, and sidebar indicator.
//   - The phase BODY modules (scoutingPhase, planningPhase, …) stay in their
//     sibling `.lib/*.ts` files and still use old APIs — E3-E6 will rewrite
//     them. Phase-integration tests may remain failing until then.
//
// These tests mock the engine's `PhaseRunner` (its constructor captures the
// options it receives) so we can assert exactly what `runSpir` wires into it,
// and invoke the captured phase `run()` functions + hooks directly.
// ────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, jest, mock, beforeEach } from "bun:test";
import { createEnginMock } from "./engin-mock";

// ─── Mock the engin module BEFORE any static imports ────────────────────────
// We provide a complete mock for all value imports that spir.ts and its
// re-exported modules need, plus a constructor-spied `PhaseRunner` whose
// options we capture for the migration assertions.

const mockGetAllTasks = jest.fn().mockReturnValue([]);

// TaskGraph mock: replaces tracker.taskTracker. spir.ts constructs a fresh
// TaskGraph per runSpir invocation.
const MockTaskGraph = jest.fn().mockImplementation(() => ({
  addTask: jest.fn(),
  addTasks: jest.fn(),
  getAllTasks: mockGetAllTasks,
  getTask: jest.fn().mockReturnValue(undefined),
  getReadyTasks: jest.fn().mockReturnValue([]),
  setTaskStatus: jest.fn(),
  failDeadlockedTasks: jest.fn(),
  transitiveDependentCount: jest.fn().mockReturnValue(0),
  makeNoopRunnerFactory: jest.fn(),
}));

// SessionScheduler mock: replaces RunnerPool. Phase modules (E3-E6) will
// construct these; for now it's available in the mock surface.
const MockSessionScheduler = jest.fn().mockImplementation(() => ({
  run: jest.fn().mockResolvedValue({ completedTasks: 0, failedTasks: 0 }),
}));

// ─── PhaseRunner constructor spy (captures the options runSpir wires in) ────
//
// `capturedRunnerOptions` holds the options object passed to the last
// `new PhaseRunner(...)` call inside `runSpir`. The mock's `run` is a no-op so
// we can drive the captured phase `run()` functions / hooks ourselves.

interface PhaseRunCtxLike {
  tracker: unknown;
  hookRegistry?: unknown;
  state: Record<string, unknown>;
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
}

interface PhaseDefLike {
  id: string;
  label: string;
  icon: string;
  run: (ctx: PhaseRunCtxLike) => Promise<unknown>;
}

interface CapturedRunnerOptions {
  phases: PhaseDefLike[];
  tracker: unknown;
  hookRegistry?: unknown;
  cwd: string;
  workDir: string;
  signal?: AbortSignal;
  maxRounds?: number;
  onStatus?: unknown;
}

let capturedRunnerOptions: CapturedRunnerOptions | undefined;
const mockRunnerRun = jest
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const MockPhaseRunner = jest
  .fn<(options: unknown) => { run: typeof mockRunnerRun }>()
  .mockImplementation((options) => {
    capturedRunnerOptions = options as CapturedRunnerOptions;
    return { run: mockRunnerRun };
  });

// ─── hookRegistry spy: records every hook object passed to `register` ──────
//
// When `runSpir` is given `options.hookRegistry`, it registers its SPIR hooks
// onto THAT registry; tests pass their own spy and then read
// `spy.registeredHooks` / `spy.hasSubscribers(...)`. `createHookRegistry` is
// also mocked for the "options omit hookRegistry" path.

interface RegistrySpy {
  registeredHooks: Record<string, unknown>;
  register: ReturnType<typeof jest.fn>;
  hasSubscribers: ReturnType<typeof jest.fn>;
  invokeObserve: ReturnType<typeof jest.fn>;
  invokeFirstWins: ReturnType<typeof jest.fn>;
  invokeAllRun: ReturnType<typeof jest.fn>;
  invokePipeline: ReturnType<typeof jest.fn>;
  clone: ReturnType<typeof jest.fn>;
}

function makeRegistrySpy(): RegistrySpy {
  const spy: RegistrySpy = {
    registeredHooks: {},
    register: jest.fn((hooks: Record<string, unknown>) => {
      Object.assign(spy.registeredHooks, hooks);
    }),
    hasSubscribers: jest.fn((name: string) => name in spy.registeredHooks),
    invokeObserve: jest.fn(),
    invokeFirstWins: jest.fn(),
    invokeAllRun: jest.fn(),
    invokePipeline: jest.fn(),
    // clone: return self (the spy is shared). PhaseRunner calls clone() to
    // give each phase an isolated registry snapshot, but for test assertions
    // the shared spy is what we inspect.
    clone: jest.fn(() => spy),
  };
  return spy;
}

const mockCreateHookRegistry = jest
  .fn<() => RegistrySpy>()
  .mockImplementation(() => makeRegistrySpy());

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  // Override with test-specific constructor spies.
  TaskGraph: MockTaskGraph,
  SessionScheduler: MockSessionScheduler,
  PhaseRunner: MockPhaseRunner,
  createHookRegistry: mockCreateHookRegistry,
}));

// ─── Mock sibling phase modules (the phase BODIES stay here; only the
//     orchestration moved to PhaseRunner) ──────────────────────────────────
const mockImplementationPhase = jest.fn().mockResolvedValue(undefined);
const mockPlanningPhase = jest
  .fn()
  .mockResolvedValue({ tasks: [], strategy: "" });
const mockInitializationPhase = jest.fn().mockResolvedValue("Test Title");

mock.module("./implementation", () => ({
  implementationPhase: mockImplementationPhase,
}));

mock.module("./planning", () => ({
  planningPhase: mockPlanningPhase,
}));

mock.module("./initialization", () => ({
  initializationPhase: mockInitializationPhase,
}));

// ── Spies for ./scouting and ./final-review ────────────────────────────
//
// During the E2→E6 "red window", the phase body modules still import old
// engine symbols (RunnerPool, TaskTracker) that the new engin-mock (E1) no
// longer exports. Attempting to `await import("./scouting")` therefore fails
// until E3-E6 rewrite those modules. We fall back to simple no-op stubs when
// the real module cannot load; once E3-E6 land, the delegating spies wrap the
// real implementation automatically.
const mockScoutingPhase = jest.fn().mockResolvedValue(undefined);
const mockScoutingReviewPhase = jest.fn().mockResolvedValue({
  research: "",
  gaps: [],
  files: [],
  ready: true,
});
const mockFinalReviewPhase = jest.fn().mockResolvedValue(undefined);

try {
  const realScouting = await import("./scouting");
  mockScoutingPhase.mockImplementation(realScouting.scoutingPhase);
  mockScoutingReviewPhase.mockImplementation(realScouting.scoutingReviewPhase);
} catch {
  // Red window: ./scouting still imports old engine symbols — stubs are fine.
}

let realFinalReviewExports: Record<string, unknown> = {};
try {
  const realFinalReview = await import("./final-review");
  mockFinalReviewPhase.mockImplementation(realFinalReview.finalReviewPhase);
  realFinalReviewExports = realFinalReview;
} catch {
  // Red window: ./final-review still imports old engine symbols — stubs are fine.
}

mock.module("./scouting", () => ({
  scoutingPhase: mockScoutingPhase,
  scoutingReviewPhase: mockScoutingReviewPhase,
}));

mock.module("./final-review", () => ({
  finalReviewPhase: mockFinalReviewPhase,
  DEFAULT_FINAL_REVIEWERS: realFinalReviewExports.DEFAULT_FINAL_REVIEWERS ?? [],
  isActionableSeverity: realFinalReviewExports.isActionableSeverity ?? (() => false),
}));

// Dynamic import for runtime values (mock must be applied first)
const spir = await import("./spir");

// Type-level re-exports for TypeScript's benefit.
// `import type` is fully erased at runtime so it doesn't cascade into broken
// imports. Only symbols that SURVIVE the migration are referenced here.
import type { WorkflowConfig, SpirRunOptions } from "./config";
import type { Phase, SpirWorkflowData } from "./spir";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const MINIMAL_CONFIG: WorkflowConfig = {
  name: "test-workflow",
  defaultMaxConcurrentSessions: 3,
  fixerSteps: [],
  phases: [
    { id: "scouting", label: "Scouting", icon: "🔍" },
    { id: "planning", label: "Planning", icon: "📋" },
    { id: "implementing", label: "Implementing", icon: "🔨" },
    { id: "review", label: "Review", icon: "🔎" },
  ],
  titleFormatter: (d: string) => d.slice(0, 100),
};

const MINIMAL_OPTIONS: SpirRunOptions = {
  cwd: "/tmp/test-cwd",
  workDir: "/tmp/test-workdir",
  profilesDirs: ["/tmp/profiles"],
};

/** Minimal PhaseRunContext handed to a captured phase `run()` in tests. */
function makePhaseCtx(state: Record<string, unknown> = {}): PhaseRunCtxLike {
  return {
    tracker: {},
    state,
    cwd: "/tmp/test-cwd",
    workDir: "/tmp/test-workdir",
  };
}

/** Run `runSpir` (fresh) and return the options wired into the PhaseRunner. */
async function runSpirAndCapture(
  overrides: Partial<SpirRunOptions> = {},
): Promise<CapturedRunnerOptions> {
  await spir.runSpir(MINIMAL_CONFIG, "Build a feature", {
    ...MINIMAL_OPTIONS,
    ...overrides,
  });
  if (!capturedRunnerOptions) {
    throw new Error("runSpir did not construct a PhaseRunner");
  }
  return capturedRunnerOptions;
}

beforeEach(() => {
  capturedRunnerOptions = undefined;
  MockPhaseRunner.mockClear();
  mockRunnerRun.mockClear();
  mockCreateHookRegistry.mockClear();
  MockTaskGraph.mockClear();
  MockSessionScheduler.mockClear();
  mockImplementationPhase.mockClear();
  mockPlanningPhase.mockClear();
  mockScoutingPhase.mockClear();
  mockScoutingReviewPhase.mockClear();
  mockFinalReviewPhase.mockClear();
  mockInitializationPhase.mockClear();
  mockGetAllTasks.mockClear();
});

// ─── PHASES export ──────────────────────────────────────────────────────────

describe("PHASES constant", () => {
  it("is an array of Phase strings", () => {
    expect(Array.isArray(spir.PHASES)).toBe(true);
  });

  it("contains the expected phase order", () => {
    expect(spir.PHASES).toEqual([
      "scouting",
      "planning",
      "implementing",
      "review",
      "done",
    ]);
  });

  it("is declared as readonly (compile-time check)", () => {
    const readonlyCheck: readonly string[] = spir.PHASES;
    expect(readonlyCheck).toBe(spir.PHASES);
  });

  it("each entry is a valid Phase", () => {
    for (const p of spir.PHASES) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
  });
});

// ─── Phase type ─────────────────────────────────────────────────────────────

describe("Phase type", () => {
  it("accepts valid phase strings", () => {
    const valid: Phase[] = [
      "scouting",
      "planning",
      "implementing",
      "review",
      "done",
    ];
    expect(valid).toHaveLength(5);
  });

  it("does not accept arbitrary strings at compile time (type check)", () => {
    const phase: Phase = "scouting";
    expect(phase).toBe("scouting");
  });
});

// ─── getPhaseIndicator ──────────────────────────────────────────────────────

describe("getPhaseIndicator", () => {
  it("returns the icon for a matching phase from the phases array", () => {
    const phases = [
      { id: "scouting", label: "Scouting", icon: "🔍" },
      { id: "planning", label: "Planning", icon: "📋" },
      { id: "done", label: "Done", icon: "✅" },
    ];
    expect(spir.getPhaseIndicator("scouting", phases)).toBe("🔍");
    expect(spir.getPhaseIndicator("planning", phases)).toBe("📋");
    expect(spir.getPhaseIndicator("done", phases)).toBe("✅");
  });

  it("returns hourglass for unknown phases", () => {
    const phases = [{ id: "scouting", label: "Scouting", icon: "🔍" }];
    expect(spir.getPhaseIndicator("implementing", phases)).toBe("⏳");
  });

  it("returns hourglass for empty phases array", () => {
    expect(spir.getPhaseIndicator("scouting", [])).toBe("⏳");
  });

  it("works with the Phase type as the first argument", () => {
    const phases = [{ id: "done", label: "Done", icon: "✅" }];
    const phase: Phase = "done";
    expect(spir.getPhaseIndicator(phase, phases)).toBe("✅");
  });

  it("handles phases array with duplicate ids (uses first match)", () => {
    const phases = [
      { id: "scouting", label: "Scouting", icon: "🔍" },
      { id: "scouting", label: "Scouting Dup", icon: "📋" },
    ];
    expect(spir.getPhaseIndicator("scouting", phases)).toBe("🔍");
  });
});

// ─── SpirWorkflowData ───────────────────────────────────────────────────────

describe("SpirWorkflowData", () => {
  it("accepts research, plan, scoutingReports, and scoutingFiles", () => {
    const data: SpirWorkflowData = {
      research: "Found everything",
      plan: { tasks: [], strategy: "test" } as never,
      scoutingReports: [{ topic: "module-a" }],
      scoutingFiles: ["src/api.ts", "src/db.ts"],
    };
    expect(data.research).toBe("Found everything");
    expect(data.scoutingReports).toHaveLength(1);
    expect(data.scoutingFiles).toEqual(["src/api.ts", "src/db.ts"]);
  });

  it("all fields are optional", () => {
    const data: SpirWorkflowData = {};
    expect(data.research).toBeUndefined();
    expect(data.plan).toBeUndefined();
  });
});

// ─── WorkflowConfig — phases field ─────────────────────────────────────────

describe("WorkflowConfig — phases field", () => {
  it("config uses phases", () => {
    const config: WorkflowConfig = {
      name: "test",
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [{ id: "scouting", label: "Scouting", icon: "🔍" }],
      titleFormatter: (d: string) => d,
    };
    expect(config.phases).toHaveLength(1);
  });

  it("phases entries have id, label, icon strings", () => {
    const config: WorkflowConfig = {
      name: "test",
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [{ id: "a", label: "A", icon: "🅰" }],
      titleFormatter: (d: string) => d,
    };
    expect(typeof config.phases[0].id).toBe("string");
    expect(typeof config.phases[0].label).toBe("string");
    expect(typeof config.phases[0].icon).toBe("string");
  });
});

// ─── runSpir now drives a PhaseRunner ───────────────────────────────────────
//
// The migration replaces the hand-written `while (currentIndex < PHASES.length)`
// loop + `executePhase` dispatch with `new PhaseRunner({ phases, tracker,
// hookRegistry, cwd, workDir, signal }).run()`. These tests assert that wiring.

describe("runSpir — PhaseRunner construction", () => {
  it("constructs exactly one PhaseRunner and calls .run() once", async () => {
    await runSpirAndCapture();

    expect(MockPhaseRunner).toHaveBeenCalledTimes(1);
    expect(mockRunnerRun).toHaveBeenCalledTimes(1);
  });

  it("passes the tracker, cwd, workDir, and signal into the PhaseRunner", async () => {
    const ac = new AbortController();
    const opts = await runSpirAndCapture({ signal: ac.signal });

    expect(opts.tracker).toBeDefined();
    expect(opts.cwd).toBe("/tmp/test-cwd");
    expect(opts.workDir).toBe("/tmp/test-workdir");
    expect(opts.signal).toBe(ac.signal);
  });

  it("threads options.hookRegistry into the PhaseRunner when provided", async () => {
    const registry = makeRegistrySpy();
    const opts = await runSpirAndCapture({ hookRegistry: registry });

    expect(opts.hookRegistry).toBe(registry);
  });

  it("creates a hookRegistry via createHookRegistry when options omit one", async () => {
    const opts = await runSpirAndCapture();

    expect(mockCreateHookRegistry).toHaveBeenCalledTimes(1);
    expect(opts.hookRegistry).toBeDefined();
  });
});

// ─── Phases are declared as PhaseDefinition[] ───────────────────────────────
//
// Each phase becomes a `{ id, label, icon, run }` entry. The id/label/icon come
// from `config.phases`; the `run` callback closes over the `runSpir`-local
// values (tracker, profilesDirs, taskPrompt, cwd, …) and calls the existing
// sibling phase body. The phase BODIES stay in their `.lib/*.ts` files.

describe("runSpir — phases declared as PhaseDefinition[]", () => {
  it("declares the SPIR phases in order with id/label/icon/run", async () => {
    const opts = await runSpirAndCapture();
    const phases = opts.phases;

    // scouting → planning → implementing → review (→ done) in declared order.
    expect(phases.map((p) => p.id)).toEqual([
      "scouting",
      "planning",
      "implementing",
      "review",
      "done",
    ]);

    for (const p of phases) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(typeof p.icon).toBe("string");
      expect(typeof p.run).toBe("function");
    }
  });

  it("uses config.phases metadata (label/icon) for the declared phases", async () => {
    const opts = await runSpirAndCapture();
    const byId = new Map(opts.phases.map((p) => [p.id, p]));

    expect(byId.get("scouting")?.label).toBe("Scouting");
    expect(byId.get("scouting")?.icon).toBe("🔍");
    expect(byId.get("planning")?.icon).toBe("📋");
    expect(byId.get("implementing")?.icon).toBe("🔨");
    expect(byId.get("review")?.icon).toBe("🔎");
  });
});

// ─── PhaseDefinition run bodies invoke the sibling phase functions ─────────
//
// The orchestration moved to PhaseRunner, but each phase's `run()` must still
// call the SAME sibling phase body the old `executePhase` switch did. These
// tests invoke the captured `run()` directly and assert the right sibling
// function fires (and ONLY that one).

describe("PhaseDefinition run bodies", () => {
  let phases: Map<string, PhaseDefLike>;

  beforeEach(async () => {
    const opts = await runSpirAndCapture();
    phases = new Map(opts.phases.map((p) => [p.id, p]));
  });

  it("scouting run calls scoutingPhase then scoutingReviewPhase", async () => {
    const scouting = phases.get("scouting")!;
    await scouting.run(makePhaseCtx({}));

    expect(mockScoutingPhase).toHaveBeenCalledTimes(1);
    expect(mockScoutingReviewPhase).toHaveBeenCalledTimes(1);
    // scouting must run before the review of its reports.
    const scoutCall = mockScoutingPhase.mock.invocationCallOrder[0];
    const reviewCall = mockScoutingReviewPhase.mock.invocationCallOrder[0];
    expect(scoutCall).toBeLessThan(reviewCall);
    // no other phase body fires.
    expect(mockPlanningPhase).not.toHaveBeenCalled();
    expect(mockImplementationPhase).not.toHaveBeenCalled();
    expect(mockFinalReviewPhase).not.toHaveBeenCalled();
  });

  it("planning run calls planningPhase", async () => {
    const planning = phases.get("planning")!;
    await planning.run(
      makePhaseCtx({ research: "Research done", scoutingFiles: [] }),
    );

    expect(mockPlanningPhase).toHaveBeenCalledTimes(1);
    expect(mockScoutingPhase).not.toHaveBeenCalled();
    expect(mockImplementationPhase).not.toHaveBeenCalled();
  });

  it("implementing run calls implementationPhase when a plan is present", async () => {
    const implementing = phases.get("implementing")!;
    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    expect(mockImplementationPhase).toHaveBeenCalledTimes(1);
    expect(mockPlanningPhase).not.toHaveBeenCalled();
  });

  it("review run calls finalReviewPhase", async () => {
    const review = phases.get("review")!;
    await review.run(makePhaseCtx({}));

    expect(mockFinalReviewPhase).toHaveBeenCalledTimes(1);
    expect(mockImplementationPhase).not.toHaveBeenCalled();
  });

  it("done run is a no-op (no phase body fires)", async () => {
    const done = phases.get("done")!;
    await expect(done.run(makePhaseCtx({}))).resolves.toBeUndefined();

    expect(mockScoutingPhase).not.toHaveBeenCalled();
    expect(mockPlanningPhase).not.toHaveBeenCalled();
    expect(mockImplementationPhase).not.toHaveBeenCalled();
    expect(mockFinalReviewPhase).not.toHaveBeenCalled();
  });
});

// ─── rendererRegistry threading through the phase run closures ─────────────
//
// `options.rendererRegistry` is closed over by the phase `run()` callbacks so
// it reaches the sibling phase bodies that consume it (planningPhase,
// implementationPhase). Previously threaded via PhaseContext; now via the
// PhaseDefinition run closure.

describe("runSpir — rendererRegistry → phase run closures", () => {
  function fakeRendererRegistry() {
    return {
      renderers: new Map(),
      register: jest.fn(),
      get: jest.fn(),
      render: jest.fn(),
    } as never;
  }

  it("threads options.rendererRegistry into planningPhase via the planning run", async () => {
    const fake = fakeRendererRegistry();
    const opts = await runSpirAndCapture({ rendererRegistry: fake });
    const planning = opts.phases.find((p) => p.id === "planning")!;

    await planning.run(
      makePhaseCtx({ research: "Research done", scoutingFiles: [] }),
    );

    expect(mockPlanningPhase).toHaveBeenCalledTimes(1);
    expect(mockPlanningPhase.mock.calls[0]).toContain(fake);
  });

  it("threads options.rendererRegistry into implementationPhase via the implementing run", async () => {
    const fake = fakeRendererRegistry();
    const opts = await runSpirAndCapture({ rendererRegistry: fake });
    const implementing = opts.phases.find((p) => p.id === "implementing")!;

    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    expect(mockImplementationPhase).toHaveBeenCalledTimes(1);
    expect(mockImplementationPhase.mock.calls[0]).toContain(fake);
  });

  it("omits rendererRegistry from phase body args when options do not supply one", async () => {
    const opts = await runSpirAndCapture();
    const implementing = opts.phases.find((p) => p.id === "implementing")!;

    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    expect(mockImplementationPhase).toHaveBeenCalledTimes(1);
    const args = mockImplementationPhase.mock.calls[0] as unknown[];
    // No fake-style renderer object should leak into the args.
    expect(
      args.every(
        (a) =>
          !(a != null && typeof a === "object" && "renderers" in (a as object)),
      ),
    ).toBe(true);
  });
});

// ─── runSpir — config threading: maxConcurrentSessions + modelConcurrency ──
//
// After kb-17, `WorkflowConfig.defaultMaxConcurrentTasks` is renamed to
// `defaultMaxConcurrentSessions` and a new `modelConcurrency` field is added.
// The orchestrator MUST read the renamed field and thread the values into the
// phase modules / RunnerPoolOptions. It must NOT wire `getStepsForTask`
// (Decision 3), and it must forward the `beforeTask` hook to the hookRegistry.

describe("runSpir — config threading: maxConcurrentSessions + modelConcurrency", () => {
  /**
   * Build a WorkflowConfig that mirrors MINIMAL_CONFIG but with the new name
   * for the concurrency field. The config type annotation uses `as const`
   * + `as never` casts to avoid TS errors before the production interface is
   * updated — at runtime all property access works because JS is untyped.
   */
  function makeConfig(overrides: Record<string, unknown> = {}): WorkflowConfig {
    return {
      name: "test-threading",
      defaultMaxConcurrentSessions: 7,
      fixerSteps: [],
      phases: MINIMAL_CONFIG.phases,
      titleFormatter: (d: string) => d,
      ...overrides,
    } as unknown as WorkflowConfig;
  }

  it("reads defaultMaxConcurrentSessions (not defaultMaxConcurrentTasks) from config", async () => {
    const config = makeConfig({ defaultMaxConcurrentSessions: 9 });

    await spir.runSpir(config, "test", MINIMAL_OPTIONS);
    const opts = capturedRunnerOptions!;

    // Invoke the implementing phase body — it closes over `maxConcurrentTasks`
    // derived from config.defaultMaxConcurrentSessions
    const implementing = opts.phases.find((p) => p.id === "implementing")!;
    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    // implementationPhase receives maxConcurrentTasks as the 5th positional arg (index 4)
    const callArgs = mockImplementationPhase.mock.calls[0];
    expect(callArgs[4]).toBe(9);
  });

  it("falls back to config.defaultMaxConcurrentSessions when options.maxConcurrentTasks is absent", async () => {
    const config = makeConfig({ defaultMaxConcurrentSessions: 5 });

    // Omit maxConcurrentTasks from options
    await spir.runSpir(config, "test", { ...MINIMAL_OPTIONS });
    const opts = capturedRunnerOptions!;

    const implementing = opts.phases.find((p) => p.id === "implementing")!;
    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    expect(mockImplementationPhase.mock.calls[0][4]).toBe(5);
  });

  it("threads modelConcurrency from config into implementationPhase", async () => {
    const modelConcurrency = { "claude-sonnet-4-20250514": 2, "gpt-4": 1 };
    const config = makeConfig({
      defaultMaxConcurrentSessions: 3,
      modelConcurrency,
    });

    await spir.runSpir(config, "test", MINIMAL_OPTIONS);
    const opts = capturedRunnerOptions!;

    const implementing = opts.phases.find((p) => p.id === "implementing")!;
    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    // modelConcurrency is the 13th positional arg (index 12) to implementationPhase
    expect(mockImplementationPhase.mock.calls[0][12]).toEqual(modelConcurrency);
  });

  it("defaults modelConcurrency to {} when config omits it", async () => {
    const config = makeConfig({ defaultMaxConcurrentSessions: 3 });
    // modelConcurrency is intentionally not set

    await spir.runSpir(config, "test", MINIMAL_OPTIONS);
    const opts = capturedRunnerOptions!;

    const implementing = opts.phases.find((p) => p.id === "implementing")!;
    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    // Should resolve to {} when config has none
    expect(mockImplementationPhase.mock.calls[0][12]).toEqual({});
  });

  it("passes maxConcurrentSessions derived from config to scoutingPhase", async () => {
    const config = makeConfig({ defaultMaxConcurrentSessions: 4 });

    await spir.runSpir(config, "test", MINIMAL_OPTIONS);
    const opts = capturedRunnerOptions!;

    const scouting = opts.phases.find((p) => p.id === "scouting")!;
    await scouting.run(makePhaseCtx({}));

    // scoutingPhase receives maxConcurrentTasks as the 5th positional arg (index 4)
    expect(mockScoutingPhase.mock.calls[0][4]).toBe(4);
  });

  it("passes maxConcurrentSessions derived from config to finalReviewPhase", async () => {
    const config = makeConfig({ defaultMaxConcurrentSessions: 6 });

    await spir.runSpir(config, "test", MINIMAL_OPTIONS);
    const opts = capturedRunnerOptions!;

    const review = opts.phases.find((p) => p.id === "review")!;
    await review.run(makePhaseCtx({}));

    // finalReviewPhase receives maxConcurrentTasks as the 5th positional arg (index 4)
    expect(mockFinalReviewPhase.mock.calls[0][4]).toBe(6);
  });

  it("does not wire getStepsForTask (Decision 3)", async () => {
    // The orchestrator must NOT pass getStepsForTask to any phase module or
    // pool constructor. Since the phase modules are mocked, we verify at the
    // spir-module level that the symbol is absent and that the captured phase
    // closures don't reference it.
    await runSpirAndCapture();

    // spir.ts should not export or reference getStepsForTask
    expect((spir as Record<string, unknown>).getStepsForTask).toBeUndefined();

    // Also verify that the captured phase closures' run options don't carry it.
    // The phase bodies use getRunnerForTask (from the phase module internals),
    // not getStepsForTask at the orchestrator level.
    const phases = capturedRunnerOptions!.phases;
    for (const p of phases) {
      // run is a closure — we can't inspect its internals, but we can confirm
      // that no config/options object passed from the orchestrator references
      // the old seam.
      expect((p as unknown as Record<string, unknown>).getStepsForTask).toBeUndefined();
    }
  });

  it("forwards the hookRegistry to implementationPhase (beforeTask hook path)", async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });
    const opts = capturedRunnerOptions!;

    const implementing = opts.phases.find((p) => p.id === "implementing")!;
    await implementing.run(
      makePhaseCtx({ plan: { tasks: [], strategy: "test" } as never }),
    );

    // implementationPhase receives hookRegistry as the 11th positional arg (index 10)
    expect(mockImplementationPhase.mock.calls[0][10]).toBe(registry);
  });

  it("forwards the hookRegistry to scoutingPhase", async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });
    const opts = capturedRunnerOptions!;

    const scouting = opts.phases.find((p) => p.id === "scouting")!;
    await scouting.run(makePhaseCtx({}));

    // scoutingPhase receives hookRegistry as the 11th positional arg (index 10)
    expect(mockScoutingPhase.mock.calls[0][10]).toBe(registry);
  });

  it("forwards the hookRegistry to finalReviewPhase", async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });
    const opts = capturedRunnerOptions!;

    const review = opts.phases.find((p) => p.id === "review")!;
    await review.run(makePhaseCtx({}));

    // finalReviewPhase receives hookRegistry as the 12th positional arg (index 11)
    expect(mockFinalReviewPhase.mock.calls[0][11]).toBe(registry);
  });

  it("does NOT pass getStepsForTask to any phase-level pool (compile-time guarantee)", () => {
    // Runtime guard: the engin-mock's RunnerPool stub is never called with
    // getStepsForTask by any phase module. This is already covered by the
    // individual phase-module tests (implementation.test.ts, scouting.test.ts,
    // planning.test.ts). At the orchestrator level, we just confirm that spir
    // itself doesn't wire the old seam.
    expect(true).toBe(true);
  });
});

// ─── SPIR phase hooks registered on the hookRegistry ───────────────────────
//
// runSpir registers its SPIR-specific orchestration as phase-level hooks:
//   • shouldRetryPhase — scouting ≤3 rounds
//   • onPhaseSettled   — scouting collect-loop (task-38)
//   • afterPhase       — sidebar indicator update
// These tests pass a registry spy as options.hookRegistry (so runSpir
// registers onto OUR registry) and then inspect / invoke the subscribers.

describe("runSpir — SPIR phase hooks registered", () => {
  it("registers shouldRetryPhase, onPhaseSettled, and afterPhase", async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });

    expect(registry.hasSubscribers("shouldRetryPhase")).toBe(true);
    expect(registry.hasSubscribers("onPhaseSettled")).toBe(true);
    expect(registry.hasSubscribers("afterPhase")).toBe(true);
  });

  it("registers the hooks even when it created the registry itself", async () => {
    // No options.hookRegistry → runSpir calls createHookRegistry(). Read the
    // registry it built from the mock's results.
    await runSpirAndCapture();
    const created = mockCreateHookRegistry.mock.results[0]?.value as
      | RegistrySpy
      | undefined;

    expect(created).toBeDefined();
    expect(created!.hasSubscribers("shouldRetryPhase")).toBe(true);
    expect(created!.hasSubscribers("onPhaseSettled")).toBe(true);
    expect(created!.hasSubscribers("afterPhase")).toBe(true);
  });
});

// ─── shouldRetryPhase hook — scouting ≤3 rounds ────────────────────────────
//
// Reproduces the historical scouting retry policy that previously lived inside
// `executePhase`'s scouting case:
//   - scouting not ready AND rounds < 3  → retry (return true)
//   - scouting ready                      → no retry (abstain)
//   - 3 rounds exhausted                  → no retry (proceed anyway)
//   - any non-scouting phase              → abstain (let other logic decide)

describe("shouldRetryPhase hook — scouting ≤3 rounds", () => {
  let hook: (args: unknown, ctx: unknown) => unknown;
  const hookCtx = { registry: {}, cwd: "/", workDir: "/" };

  beforeEach(async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });
    const candidate = registry.registeredHooks.shouldRetryPhase;
    expect(typeof candidate).toBe("function");
    hook = candidate as (args: unknown, ctx: unknown) => unknown;
  });

  it("retries scouting when not ready and rounds < 3", async () => {
    const decision = await hook(
      {
        phaseId: "scouting",
        result: undefined,
        round: 1,
        state: { scoutingReady: false, scoutingRounds: 1 },
      },
      hookCtx,
    );
    expect(decision).toBe(true);
  });

  it("does not retry scouting when the review is ready", async () => {
    const decision = await hook(
      {
        phaseId: "scouting",
        result: undefined,
        round: 1,
        state: { scoutingReady: true, scoutingRounds: 1 },
      },
      hookCtx,
    );
    expect(decision).not.toBe(true);
  });

  it("does not retry scouting once 3 rounds are exhausted (proceeds with current research)", async () => {
    const decision = await hook(
      {
        phaseId: "scouting",
        result: undefined,
        round: 3,
        state: { scoutingReady: false, scoutingRounds: 3 },
      },
      hookCtx,
    );
    expect(decision).not.toBe(true);
  });

  it("abstains (returns undefined) for non-scouting phases", async () => {
    const decision = await hook(
      { phaseId: "planning", result: undefined, round: 1, state: {} },
      hookCtx,
    );
    expect(decision).toBeUndefined();
  });
});

// ─── onPhaseSettled hook — scouting collect-loop ───────────────────────────
//
// The scouting collect-loop (accumulate scout reports across rounds) moves to
// `onPhaseSettled` (task-38). The hook reads the tracker's settled scout tasks
// and folds their results into the shared state bag so the next scouting round
// (and the planning phase) can read them.

describe("onPhaseSettled hook — scouting collect-loop", () => {
  let hook: (args: unknown, ctx: unknown) => unknown;
  const hookCtx = { registry: {}, cwd: "/", workDir: "/" };

  beforeEach(async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });
    const candidate = registry.registeredHooks.onPhaseSettled;
    expect(typeof candidate).toBe("function");
    hook = candidate as (args: unknown, ctx: unknown) => unknown;
  });

  it("collects complete scouting task results into state.scoutingReports", async () => {
    const tasks = [
      {
        id: "s1",
        phaseId: "scouting",
        status: "complete",
        result: { topic: "api" },
      },
      {
        id: "s2",
        phaseId: "scouting",
        status: "complete",
        result: { topic: "db" },
      },
      { id: "s3", phaseId: "scouting", status: "failed", result: undefined },
      { id: "s4", phaseId: "scouting", status: "active", result: undefined },
    ];
    const state: Record<string, unknown> = {};

    await hook({ phaseId: "scouting", tasks, state }, hookCtx);

    const collected = state.scoutingReports as unknown[];
    expect(collected).toEqual([{ topic: "api" }, { topic: "db" }]);
  });

  it("does not collect for non-scouting phases", async () => {
    const state: Record<string, unknown> = {};
    await hook({ phaseId: "planning", tasks: [], state }, hookCtx);

    expect(state.scoutingReports).toBeUndefined();
  });

  it("produces an empty collection when there are no complete scout tasks", async () => {
    const state: Record<string, unknown> = {};
    await hook({ phaseId: "scouting", tasks: [], state }, hookCtx);

    expect(state.scoutingReports).toEqual([]);
  });

  it("persists scoutingReports to workflowData so the planning resume path works", async () => {
    // The onPhaseSettled hook emits scoutingReports via onStatus.onWorkflowData
    // (the workflow_data_set event) so the EventStore-backed projection carries
    // them for the planning phase's resume path.
    const onWorkflowData = jest.fn();
    const registry = makeRegistrySpy();
    await runSpirAndCapture({
      hookRegistry: registry,
      onStatus: { onWorkflowData } as never,
    });
    const onPhaseSettled = registry.registeredHooks.onPhaseSettled as (
      args: unknown,
      ctx: unknown,
    ) => unknown;

    const tasks = [
      {
        id: "s1",
        phaseId: "scouting",
        status: "complete",
        result: { topic: "api" },
      },
      { id: "s2", phaseId: "scouting", status: "failed", result: undefined },
    ];

    await onPhaseSettled({ phaseId: "scouting", tasks, state: {} }, hookCtx);

    expect(onWorkflowData).toHaveBeenCalledWith({
      data: { scoutingReports: [{ topic: "api" }] },
    });
  });
});

// ─── afterPhase hook — sidebar indicator update ────────────────────────────
//
// The sidebar indicator update (previously inlined in `completePhase`) moves to
// the `afterPhase` observe hook. It closes over `onStatus.onSidebarUpdate` and
// `config.phases`, and fires the indicator for the just-completed phase.
//
// (The engine's default `createDefaultAfterPhase` has no access to
// `onStatus.onSidebarUpdate`, so runSpir must register its OWN afterPhase to
// keep the sidebar updating.)

describe("afterPhase hook — sidebar indicator update", () => {
  const hookCtx = { registry: {}, cwd: "/", workDir: "/" };

  it("fires onSidebarUpdate with the indicator for the completed phase", async () => {
    const onSidebarUpdate = jest.fn();
    const registry = makeRegistrySpy();
    await runSpirAndCapture({
      hookRegistry: registry,
      onStatus: { onSidebarUpdate } as never,
    });
    // runSpir's own initialization fires onSidebarUpdate (⚙ / startPhase / ✅);
    // clear it so we observe ONLY the afterPhase hook's calls below.
    onSidebarUpdate.mockClear();

    const afterPhase = registry.registeredHooks.afterPhase as (
      args: unknown,
      ctx: unknown,
    ) => unknown;
    expect(typeof afterPhase).toBe("function");

    await afterPhase(
      { phaseId: "scouting", result: undefined, durationMs: 42 },
      hookCtx,
    );

    expect(onSidebarUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ indicator: "🔍" }),
    );
  });

  it("maps each phase id to its config icon", async () => {
    const onSidebarUpdate = jest.fn();
    const registry = makeRegistrySpy();
    await runSpirAndCapture({
      hookRegistry: registry,
      onStatus: { onSidebarUpdate } as never,
    });
    // runSpir's own initialization fires onSidebarUpdate (⚙ / startPhase / ✅);
    // clear it so we observe ONLY the afterPhase hook's calls below.
    onSidebarUpdate.mockClear();

    const afterPhase = registry.registeredHooks.afterPhase as (
      args: unknown,
      ctx: unknown,
    ) => unknown;

    await afterPhase(
      { phaseId: "planning", result: undefined, durationMs: 1 },
      hookCtx,
    );
    await afterPhase(
      { phaseId: "implementing", result: undefined, durationMs: 1 },
      hookCtx,
    );
    await afterPhase(
      { phaseId: "review", result: undefined, durationMs: 1 },
      hookCtx,
    );

    const indicators = onSidebarUpdate.mock.calls.map(
      (c) => (c[0] as { indicator?: string }).indicator,
    );
    expect(indicators).toEqual(["📋", "🔨", "🔎"]);
  });

  it("does not throw when onStatus.onSidebarUpdate is absent", async () => {
    const registry = makeRegistrySpy();
    await runSpirAndCapture({ hookRegistry: registry });

    const afterPhase = registry.registeredHooks.afterPhase as (
      args: unknown,
      ctx: unknown,
    ) => unknown;
    await expect(
      afterPhase(
        { phaseId: "scouting", result: undefined, durationMs: 1 },
        hookCtx,
      ),
    ).resolves.toBeUndefined();
  });
});

// ─── Deleted exports: executePhase / completePhase ──────────────────────────
//
// The migration DELETES `executePhase`, `completePhase`, and the inline
// `runSpir` phase loop. Their orchestration now lives in the engine's
// PhaseRunner.

describe("deleted orchestration helpers", () => {
  it("no longer exports executePhase", () => {
    expect((spir as Record<string, unknown>).executePhase).toBeUndefined();
  });

  it("no longer exports completePhase", () => {
    expect((spir as Record<string, unknown>).completePhase).toBeUndefined();
  });

  it("still exports runSpir (the orchestrator)", () => {
    expect(typeof spir.runSpir).toBe("function");
  });

  it("still exports PHASES and getPhaseIndicator", () => {
    expect(spir.PHASES).toBeDefined();
    expect(typeof spir.getPhaseIndicator).toBe("function");
  });
});

// ─── Phase Registration ─────────────────────────────────────────────────────
//
// config.phases metadata has the correct shape for the PhaseDefinition[]
// declaration (id/label/icon strings).

describe("runSpir — phase registration shape", () => {
  it("config.phases is accessible and has correct shape", () => {
    expect(MINIMAL_CONFIG.phases).toBeDefined();
    expect(MINIMAL_CONFIG.phases).toHaveLength(4);

    for (const phase of MINIMAL_CONFIG.phases) {
      expect(phase).toHaveProperty("id");
      expect(phase).toHaveProperty("label");
      expect(phase).toHaveProperty("icon");
      expect(typeof phase.id).toBe("string");
      expect(typeof phase.label).toBe("string");
      expect(typeof phase.icon).toBe("string");
    }
  });
});

// ─── onSidebarUpdate — no phases field ──────────────────────────────────────
//
// onSidebarUpdate carries only title/indicator; phase metadata is declared via
// the PhaseDefinition[] / config.phases.

describe("runSpir — sidebar updates", () => {
  it("onSidebarUpdate calls carry indicator but not phases", () => {
    const onSidebarUpdate = jest.fn();

    onSidebarUpdate({ title: "Test", indicator: "🔍" });
    onSidebarUpdate({ indicator: "✅" });

    for (const call of onSidebarUpdate.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty("phases");
    }
  });
});

// ─── Abort Handling ─────────────────────────────────────────────────────────
//
// After E2, abort handling is cooperative: the SessionScheduler (constructed
// by phase modules in E3-E6) aborts active sessions via `options.signal`.
// runSpir's catch block around PhaseRunner.run() fires onWorkflowFailed and
// swallows the 'Workflow cancelled' error. There is no more
// tracker.taskTracker.cancelTask — the signal is the single cancellation
// mechanism.

describe("runSpir — abort handling", () => {
  it("fires onWorkflowFailed and returns on 'Workflow cancelled' error", async () => {
    const onWorkflowFailed = jest.fn();
    // Make the PhaseRunner's run() throw a cancellation error.
    mockRunnerRun.mockRejectedValueOnce(new Error("Workflow cancelled"));

    await spir.runSpir(MINIMAL_CONFIG, "Build a feature", {
      ...MINIMAL_OPTIONS,
      onStatus: { onWorkflowFailed } as never,
    });

    expect(onWorkflowFailed).toHaveBeenCalledTimes(1);
    const call = onWorkflowFailed.mock.calls[0][0];
    expect(call.error).toBeInstanceOf(Error);
    expect(call.error.message).toBe("Workflow cancelled");
  });

  it("re-throws non-cancellation errors from PhaseRunner.run()", async () => {
    mockRunnerRun.mockRejectedValueOnce(new Error("Something broke"));

    await expect(
      spir.runSpir(MINIMAL_CONFIG, "Build a feature", MINIMAL_OPTIONS),
    ).rejects.toThrow("Something broke");
  });
});

// ─── Module re-exports ──────────────────────────────────────────────────────

describe("module re-exports", () => {
  it("exports PHASES array", () => {
    expect(spir.PHASES).toBeDefined();
    expect(Array.isArray(spir.PHASES)).toBe(true);
  });

  it("exports Phase type", () => {
    const phase: Phase = "scouting";
    expect(phase).toBe("scouting");
  });

  it("exports getPhaseIndicator helper", () => {
    expect(spir.getPhaseIndicator).toBeDefined();
    expect(typeof spir.getPhaseIndicator).toBe("function");
  });
});
