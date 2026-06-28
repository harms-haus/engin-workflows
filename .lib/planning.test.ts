// ─── Planning Phase Tests (E6 migration: kb-32) ──────────────────────────────
//
// E6 migrates planning.ts off the old WorkflowStatusTracker + RunnerPool +
// TaskTracker contract onto the new SessionPlan-contract engine:
//
//   - WorkflowStatusTracker → REMOVED (tracker.setWorkflowData → onStatus.onWorkflowData)
//   - RunnerPool            → SessionScheduler
//   - TaskTracker           → TaskGraph (graph.addTask carries runnerFactory)
//   - reviewRunner returns  → SessionPlanFactory (not a runner function)
//
// These tests assert the POST-MIGRATION contract.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import type { StatusCallbacks } from "@harms-haus/engin-engine";
import { createEnginMock } from "./engin-mock";

// ─── Mock @harms-haus/engin-engine ─────────────────────────────────────────

/**
 * Fake TaskGraph that captures tasks AND their runnerFactory — the new
 * `graph.addTask(task, runnerFactory)` signature. Lets tests assert on the
 * planning task's fields and the reviewRunner factory wiring.
 */
class MockTaskGraph {
  private entries: Map<
    string,
    { task: Record<string, unknown>; runnerFactory: () => unknown }
  > = new Map();

  addTask(task: Record<string, unknown>, runnerFactory: () => unknown) {
    if (this.entries.has(task.id as string)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }
    this.entries.set(task.id as string, {
      task: { ...task },
      runnerFactory,
    });
  }

  getAllTasks() {
    return Array.from(this.entries.values()).map((e) => e.task);
  }

  getEntry(id: string) {
    return this.entries.get(id);
  }

  reset() {
    this.entries.clear();
  }
}

// ── reviewRunner mock ────────────────────────────────────────────────────
// Captures the executeSpec, reviewSpec, and options passed to reviewRunner.
// Returns a mock SessionPlanFactory (a function that returns a SessionPlanRunner).
let lastReviewRunnerExecuteSpec: Record<string, unknown> = {};
let lastReviewRunnerReviewSpec: Record<string, unknown> = {};
let lastReviewRunnerOptions: Record<string, unknown> = {};
/** The SessionPlanFactory returned by the mock reviewRunner on the last call. */
let mockReviewRunnerFactory: (() => unknown) & {
  mockClear: () => void;
  mock: { calls: unknown[][] };
};

const mockReviewRunner = mock(
  (executeSpec: unknown, reviewSpec: unknown, options?: unknown) => {
    lastReviewRunnerExecuteSpec = executeSpec as Record<string, unknown>;
    lastReviewRunnerReviewSpec = reviewSpec as Record<string, unknown>;
    lastReviewRunnerOptions = (options ?? {}) as Record<string, unknown>;
    mockReviewRunnerFactory = mock().mockReturnValue({
      plan: mock(),
      execute: mock(),
    });
    return mockReviewRunnerFactory;
  },
);

// ── SessionScheduler mock ────────────────────────────────────────────────
// Captures the options passed to the SessionScheduler constructor and returns
// a mock with a controllable `run()` method.
let lastSchedulerOpts: Record<string, unknown> = {};
/** Controls what the mock SessionScheduler.run() resolves to (set per-test). */
let nextSchedulerResult: { completedTasks: number; failedTasks: number } = {
  completedTasks: 1,
  failedTasks: 0,
};

const mockSessionSchedulerConstructor = mock((opts: unknown) => {
  lastSchedulerOpts = opts as Record<string, unknown>;
  return {
    run: mock().mockResolvedValue(nextSchedulerResult),
  };
});

// ── TaskGraph mock ───────────────────────────────────────────────────────
// MockTaskGraph is a real class; the mock module just needs to export it.
const MockTaskGraphCtor = mock(
  (..._args: unknown[]) => new MockTaskGraph(),
);

// The shared graph instance used across tests. Each test can inspect it.
let mockGraph: MockTaskGraph;

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  SessionScheduler: mockSessionSchedulerConstructor,
  TaskGraph: MockTaskGraphCtor,
  reviewRunner: mockReviewRunner,
}));

// Dynamic import after mock is set up
const { planningPhase, getPlanPath, getArtifactsDir } =
  await import("./planning");
import type { Plan } from "./schemas";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeStatusCallbacksSpy() {
  return {
    onWorkflowData: mock(() => {}),
    onDecision: mock(() => {}),
    onTaskRegister: mock(() => {}),
    onTaskStart: mock(() => {}),
    onTaskComplete: mock(() => {}),
    onTaskRejected: mock(() => {}),
    onSessionStart: mock(() => {}),
    onSessionComplete: mock(() => {}),
  } as unknown as StatusCallbacks;
}

const SAMPLE_PLAN: Plan = {
  tasks: [
    {
      id: "task-1",
      title: "Do thing",
      prompt: "Implement",
      profile: "implementer",
      files: ["src/main.ts"],
      is_code: true,
      dependencies: [],
    },
  ],
  strategy: "Step by step",
};

/** Create a temp workDir and (optionally) pre-write a valid plan.json into it. */
function makeWorkDir(plan?: Plan): string {
  const workDir = mkdtempSync(join(tmpdir(), "planning-wd-"));
  if (plan) {
    mkdirSync(getArtifactsDir(workDir), { recursive: true });
    writeFileSync(getPlanPath(workDir), JSON.stringify(plan, null, 2));
  }
  return workDir;
}

/** Read the live planning.ts source text (for import / deletion assertions). */
function planningSource(): string {
  return readFileSync(
    fileURLToPath(new URL("./planning.ts", import.meta.url)),
    "utf-8",
  );
}

/**
 * Minimal fake `HookRegistry` whose `beforeStepPrompt` (pipeline) subscriber
 * inlines `args.task.files` read against `ctx.cwd` — mirroring the engine's
 * `defaultCollectContext` / `defaultBeforeStepPrompt` contract. Lets tests
 * prove the planner STILL receives file context, now via the engine path.
 */
function makeInliningHookRegistry(): unknown {
  return {
    register() {},
    hasSubscribers(name: string) {
      return name === "beforeStepPrompt";
    },
    async invokeObserve() {},
    async invokeFirstWins() {
      return undefined;
    },
    async invokeAllRun() {
      return undefined;
    },
    async invokePipeline(
      name: string,
      value: unknown,
      args: unknown,
      ctx: unknown,
    ) {
      if (name !== "beforeStepPrompt") return value as string;
      const files =
        (args as { task?: { files?: string[] } })?.task?.files ?? [];
      const cwd = (ctx as { cwd?: string } | null)?.cwd ?? ".";
      const blocks: string[] = [];
      for (const fp of files) {
        let content: string | null = null;
        try {
          content = readFileSync(isAbsolute(fp) ? fp : join(cwd, fp), "utf-8");
        } catch {
          /* unreadable — skip, mirroring the engine default */
        }
        if (content != null)
          blocks.push(`### ${fp}\n\`\`\`typescript\n${content}\n\`\`\``);
      }
      if (blocks.length === 0) return value as string;
      return `${value}\n\n${blocks.join("\n\n")}`;
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("planningPhase", () => {
  beforeEach(() => {
    // B3 migration mock resets
    mockReviewRunner.mockClear();
    mockSessionSchedulerConstructor.mockClear();
    lastReviewRunnerExecuteSpec = {};
    lastReviewRunnerReviewSpec = {};
    lastReviewRunnerOptions = {};
    mockReviewRunnerFactory = mock().mockReturnValue({
      plan: mock(),
      execute: mock(),
    });
    lastSchedulerOpts = {};
    nextSchedulerResult = { completedTasks: 1, failedTasks: 0 };

    // Fresh graph per test
    mockGraph = new MockTaskGraph();
  });

  // ── reviewRunner + SessionScheduler wiring ───────────────────────────────

  it("runs plan + review as ONE reviewRunner composed task dispatched via SessionScheduler", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      // reviewRunner composes plan + review-plan into a single loop runner.
      expect(mockReviewRunner).toHaveBeenCalledTimes(1);
      // SessionScheduler is constructed once and runs the planning task.
      expect(mockSessionSchedulerConstructor).toHaveBeenCalledTimes(1);
      // The planning task is registered with the expected id / title.
      const tasks = mockGraph.getAllTasks();
      expect(tasks.find((t) => t.id === "planning")).toBeDefined();
      expect(tasks.find((t) => t.title === "Plan & Review")).toBeDefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("configures the plan execute spec (structured output, PlanReadySchema)", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      const spec = lastReviewRunnerExecuteSpec;
      expect(spec.profile).toBe("planner");
      expect(spec.outputMode).toBe("structured");
      expect(spec.isReadOnly).toBe(false);
      expect(spec.schema).toBeDefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("configures the review spec (read-only, structured, PlanReviewSchema)", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      const spec = lastReviewRunnerReviewSpec;
      expect(spec.profile).toBe("plan-reviewer");
      expect(spec.outputMode).toBe("structured");
      expect(spec.isReadOnly).toBe(true);
      expect(spec.schema).toBeDefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("passes apiKeys, onStatus, signal, and rendererRegistry through to the scheduler", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const apiKeys = { openai: "sk-test" };
      const onStatus = makeStatusCallbacksSpy();
      const abortController = new AbortController();
      const fakeRegistry = {
        renderers: new Map(),
        register: mock(() => {}),
        get: mock(() => {}),
        render: mock(() => {}),
      };

      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
        apiKeys,
        onStatus,
        abortController.signal,
        fakeRegistry as never,
      );

      expect(lastSchedulerOpts.apiKeys).toBe(apiKeys);
      expect(lastSchedulerOpts.onStatus).toBe(onStatus);
      expect(lastSchedulerOpts.signal).toBe(abortController.signal);
      expect(lastSchedulerOpts.rendererRegistry).toBe(fakeRegistry);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Plan step prompt ────────────────────────────────────────────────────

  it("tells the planner to write the plan to the artifacts file path", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research results...",
        [],
        "Implement feature X",
        "/cwd",
        workDir,
      );

      const prompt = lastReviewRunnerExecuteSpec.prompt as string;
      expect(prompt).toContain("planning agent");
      expect(prompt).toContain("Implement feature X");
      expect(prompt).toContain("Research results...");
      expect(prompt).toContain(getPlanPath(workDir));
      expect(prompt).toContain("sandboxed");
      expect(prompt).toContain("plan_ready");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── DELETED duplicate inlining code ──────────────────────────────────────

  describe("duplicate prompt-inlining code is removed", () => {
    it("no longer defines the duplicated inlining constants / helpers", () => {
      const src = planningSource();
      expect(src).not.toContain("CONTEXT_FILE_MAX_BYTES");
      expect(src).not.toContain("LANG_BY_EXT");
      expect(src).not.toContain("BINARY_EXTS");
      expect(src).not.toContain("readContextFile");
      expect(src).not.toContain("formatScoutingFilesSection");
      expect(src).not.toContain("inlineScoutingContext");
    });

    it("drops the fs/path imports that were only used by the deleted code", () => {
      const src = planningSource();
      expect(src).not.toMatch(
        /import\s*\{[^}]*\bopen\b[^}]*\}\s*from\s*["']node:fs\/promises["']/,
      );
      expect(src).not.toMatch(
        /import\s*\{[^}]*\bextname\b[^}]*\}\s*from\s*["']node:path["']/,
      );
      expect(src).not.toMatch(
        /import\s*\{[^}]*\bisAbsolute\b[^}]*\}\s*from\s*["']node:path["']/,
      );
    });

    it("still keeps readFile / join (used by the surviving plan read-back helpers)", () => {
      const src = planningSource();
      expect(src).toMatch(/readFile/);
      expect(src).toMatch(/\bjoin\b/);
    });
  });

  // ── Scouting file context is DELEGATED to the engine ──────────────────────

  describe("scouting file context is delegated to the engine (no local inlining)", () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "planning-files-"));
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src/api.ts"), 'export const API = "v1";\n');
    });
    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it("threads the scouting files onto the planning task", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          ["src/api.ts"],
          "Task",
          cwd,
          workDir,
        );

        const tasks = mockGraph.getAllTasks();
        const planningTask = tasks.find((t) => t.id === "planning")!;
        expect(planningTask.files).toEqual(["src/api.ts"]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("hands an empty files array when no scouting files were provided", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          [],
          "Task",
          cwd,
          workDir,
        );

        const tasks = mockGraph.getAllTasks();
        const planningTask = tasks.find((t) => t.id === "planning")!;
        expect(planningTask.files).toEqual([]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("does NOT inline file contents into the locally-built planner prompt", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          ["src/api.ts"],
          "Task",
          cwd,
          workDir,
        );

        const prompt = lastReviewRunnerExecuteSpec.prompt as string;
        expect(prompt).not.toContain("Key files from scouting");
        expect(prompt).not.toContain("### src/api.ts");
        expect(prompt).not.toContain('export const API = "v1";');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("threads task.files + hookRegistry so the engine beforeStepPrompt hook can inline them", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          ["src/api.ts"],
          "Task",
          cwd,
          workDir,
          undefined,
          undefined,
          undefined,
          undefined,
          makeInliningHookRegistry() as never,
        );

        const tasks = mockGraph.getAllTasks();
        const planningTask = tasks.find((t) => t.id === "planning")!;
        expect(planningTask.files).toContain("src/api.ts");
        expect(lastSchedulerOpts.hookRegistry).toBeDefined();
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ── hookRegistry threading ──────────────────────────────────────────────

  describe("hookRegistry threading (enables the engine beforeStepPrompt default)", () => {
    it("forwards the hookRegistry to the SessionScheduler", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      const fakeHookRegistry = { hasSubscribers: () => false } as never;
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          [],
          "Task",
          "/cwd",
          workDir,
          undefined,
          undefined,
          undefined,
          undefined,
          fakeHookRegistry,
        );

        expect(lastSchedulerOpts.hookRegistry).toBe(fakeHookRegistry);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("omits hookRegistry from the SessionScheduler when none is provided", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          [],
          "Task",
          "/cwd",
          workDir,
        );

        expect(lastSchedulerOpts.hookRegistry).toBeUndefined();
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ── helper imports removed (auditor migration done) ───────────────────

  describe("structuredOutputEvent / decisionEvent imports are removed (the engine auditor now handles it)", () => {
    it("no longer imports structuredOutputEvent or decisionEvent from ./helpers", () => {
      const src = planningSource();
      expect(src).not.toMatch(/from\s+["']\.\/helpers["']/);
      expect(src).not.toContain("structuredOutputEvent");
      expect(src).not.toContain("decisionEvent");
    });

    it("drops the resolved task-17 TODO", () => {
      const src = planningSource();
      expect(src).not.toContain("TODO(task-17)");
    });
  });

  // ── Review prompt (eager: tells reviewer to read the plan file) ────────

  it("instructs the reviewer to read the plan from the artifacts file path", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      const prompt = lastReviewRunnerReviewSpec.prompt as string;
      expect(prompt).toContain("reviewing an implementation plan");
      expect(prompt).toContain("Research");
      expect(prompt).toContain(getPlanPath(workDir));
      // The plan JSON is NOT inlined eagerly — the reviewer reads the file
      // at run time via the reviewRunner's filesystem-output note.
      expect(prompt).not.toContain('"id": "task-1"');
      expect(prompt).not.toContain('"strategy": "Step by step"');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Read-back & workflow data ───────────────────────────────────────────

  it("reads the written plan.json back and returns it as the validated Plan", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const result = await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );
      expect(result).toEqual(SAMPLE_PLAN);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fires onWorkflowData with the plan read from the file", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const onStatus = makeStatusCallbacksSpy();
      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
        undefined,
        onStatus,
      );
      expect(onStatus.onWorkflowData).toHaveBeenCalledWith({
        data: { plan: SAMPLE_PLAN },
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Decision / audit (final review outcome) ────────────────────────────

  it("fires onDecision with plan_approved when the review approves", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      nextSchedulerResult = { completedTasks: 1, failedTasks: 0 };
      const onStatus = makeStatusCallbacksSpy();

      await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
        undefined,
        onStatus,
      );

      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: "plan-reviewer",
        decision: "plan_approved",
        reasoning: "",
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fires onDecision with plan_rejected when the review exhausts retries", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      nextSchedulerResult = { completedTasks: 0, failedTasks: 1 };
      const onStatus = makeStatusCallbacksSpy();

      // Even on exhaustion, planningPhase proceeds with the captured plan.
      const result = await planningPhase(
        mockGraph as never,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
        undefined,
        onStatus,
      );

      expect(result).toEqual(SAMPLE_PLAN);
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: "plan-reviewer",
        decision: "plan_rejected",
        reasoning: "",
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SessionPlan migration tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("planningPhase SessionPlan migration (reviewRunner + SessionScheduler)", () => {
    // ── 1. Import contract ────────────────────────────────────────────────

    it("1. imports reviewRunner, SessionScheduler, TaskGraph and NOT RunnerPool/TaskTracker", () => {
      const src = planningSource();
      expect(src).toMatch(/\breviewRunner\b/);
      expect(src).toMatch(/\bSessionScheduler\b/);
      expect(src).toMatch(/\bTaskGraph\b/);
      // RunnerPool / TaskTracker MUST be removed
      expect(src).not.toMatch(/\bRunnerPool\b/);
      expect(src).not.toMatch(/\bTaskTracker\b/);
      expect(src).not.toMatch(/\bWorkflowStatusTracker\b/);
      expect(src).not.toMatch(/\brunMultiStepTask\b/);
    });

    // ── 2. reviewRunner composition ───────────────────────────────────────

    it("2. composes plan singleSession (structured) + review-plan singleSession (structured) via reviewRunner", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research results...",
          [],
          "Implement X",
          "/cwd",
          workDir,
        );

        // reviewRunner must be called exactly once with the two specs
        expect(mockReviewRunner).toHaveBeenCalledTimes(1);

        // Execute spec = plan step with structured output (plan_ready done-signal)
        expect(lastReviewRunnerExecuteSpec).toMatchObject({
          profile: "planner",
          outputMode: "structured",
        });
        expect(lastReviewRunnerExecuteSpec.schema).toBeDefined();
        const execPrompt = lastReviewRunnerExecuteSpec.prompt as string;
        expect(execPrompt).toContain("planning agent");
        expect(execPrompt).toContain("Implement X");
        expect(execPrompt).toContain("Research results...");

        // Review spec = review-plan step with structured output
        expect(lastReviewRunnerReviewSpec).toMatchObject({
          profile: "plan-reviewer",
          outputMode: "structured",
        });
        expect(lastReviewRunnerReviewSpec.schema).toBeDefined();
        const reviewPrompt = lastReviewRunnerReviewSpec.prompt as string;
        expect(reviewPrompt).toContain("reviewing an implementation plan");

        // Options must include maxRounds = DEFAULT_MAX_ROUNDS
        expect(lastReviewRunnerOptions).toMatchObject({
          maxRounds: 3, // DEFAULT_MAX_ROUNDS
        });
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    // ── 3. TaskGraph + SessionScheduler construction ───────────────────────

    it("3. registers the planning task with the reviewRunner factory in the TaskGraph", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research",
          [],
          "Task",
          "/cwd",
          workDir,
        );

        // SessionScheduler constructor must be called exactly once
        expect(mockSessionSchedulerConstructor).toHaveBeenCalledTimes(1);

        // The planning task must carry the reviewRunner factory
        const entry = mockGraph.getEntry("planning");
        expect(entry).toBeDefined();
        expect(entry!.runnerFactory).toBe(mockReviewRunnerFactory);

        // The SessionScheduler must receive the same graph instance
        expect(lastSchedulerOpts.graph).toBe(mockGraph);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    // ── 4. Coverage preservation ──────────────────────────────────────────

    it("4. preserves coverage: plan produced (structured done-signal), reviewed, loop retries on rejection", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
        mockGraph as never,
          ["/profiles"],
          "Research results...",
          [],
          "Implement X",
          "/cwd",
          workDir,
        );

        expect(lastReviewRunnerExecuteSpec.profile).toBe("planner");
        const execPrompt = lastReviewRunnerExecuteSpec.prompt as string;
        expect(execPrompt).toContain("`write`");
        expect(execPrompt).toContain("plan-final.json");
        expect(execPrompt).toContain("sandboxed");
        expect(execPrompt).toContain("plan_ready");

        expect(lastReviewRunnerExecuteSpec.outputMode).toBe("structured");
        expect(lastReviewRunnerExecuteSpec.schema).toBeDefined();

        expect(lastReviewRunnerReviewSpec.outputMode).toBe("structured");
        expect(lastReviewRunnerReviewSpec.schema).toBeDefined();

        const reviewPrompt = lastReviewRunnerReviewSpec.prompt as string;
        expect(reviewPrompt).toContain("reviewing an implementation plan");
        expect(reviewPrompt).toContain("Approve the plan if");

        expect(lastReviewRunnerOptions.maxRounds).toBeGreaterThanOrEqual(1);

        expect(execPrompt).not.toContain("Review feedback");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});
