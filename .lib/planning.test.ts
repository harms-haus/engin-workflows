// ─── Planning Phase Tests (B3 migration: kb-14) ──────────────────────────────
//
// Phase B3 migrates planning.ts off runMultiStepTask onto the new runner
// primitives:
//   - plan step       → singleSession (outputMode:'filesystem')
//   - review-plan step → singleSession (structured {approved, feedback})
//   - compose as      → reviewRunner(planSpec, reviewSpec, {maxRounds})
//   - orchestration   → RunnerPool with getRunnerForTask returning reviewRunner
//
// These tests are written TEST-FIRST for the B3 migration (§2.12). They assert
// the POST-MIGRATION contract and will FAIL until planning.ts is updated.
//
// ── PRE-MIGRATION tests (still pass) ──────────────────────────────────────
// Prior to B3, planningPhase calls runMultiStepTask with plan + review-plan
// steps. The tests below that examine prompt contents, duplicate-inlining
// removal, file-context delegation, hookRegistry threading, audit migration,
// and decision/read-back still pass because they test the UNCHANGED surface
// of planningPhase (argument shapes, prompt text, onStatus behavior).
//
// ── B3 MIGRATION tests (expected to FAIL until implemented) ───────────────
// The final describe block asserts the new import contract, reviewRunner
// composition, RunnerPool construction, and coverage preservation. These all
// depend on the implementation change and will fail until planning.ts is
// updated.
//
// ── Mock strategy ─────────────────────────────────────────────────────────
// The mock runMultiStepTask continues to serve the PRE-migration code path.
// Parallel mock infrastructure for reviewRunner + RunnerPool captures specs
// for the new code path. Once migration lands, the runMultiStepTask mock can
// be removed entirely.
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
import type {
  StatusCallbacks,
  WorkflowStatusTracker,
} from "@harms-haus/engin-engine";
import { createEnginMock } from "./engin-mock";

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────

class MockTaskTracker {
  private tasks: Map<string, Record<string, unknown>> = new Map();

  addTask(task: Record<string, unknown>) {
    if (this.tasks.has(task.id as string)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }
    this.tasks.set(task.id as string, {
      ...task,
      status: task.status ?? "ready",
    });
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }
}

class MockLanePool {
  constructor(_opts: Record<string, unknown>) {}
  async run() {}
}

/**
 * Shape of a step as it arrives in `opts.steps` (BEFORE the mock resolves its
 * lazy prompt). Distinct from `CapturedStep` (which stores the resolved
 * prompt text) so the mock can read `step.prompt` without a type error.
 */
interface RawStep {
  stepName: string;
  profileId: string;
  prompt:
    | string
    | ((
        priorResults: unknown[],
        ctx: { attempt: number },
      ) => Promise<string> | string);
  isReadOnly?: boolean;
  allowedWriteDirs?: string[];
  schema?: unknown;
  isApproved?: (r: unknown) => boolean;
  getFeedback?: (r: unknown) => string;
  validateOutput?: () => Promise<{ error?: string } | undefined>;
}

interface CapturedStep {
  stepName: string;
  profileId: string;
  /** Prompt text built by planningPhase (BEFORE any engine hook runs). */
  promptText: string;
  /** Prompt actually sent to the agent (AFTER the `beforeStepPrompt` hook, when one is threaded). */
  effectivePrompt: string;
  isReadOnly?: boolean;
  allowedWriteDirs?: string[];
  schema?: unknown;
  isApproved?: (r: unknown) => boolean;
  getFeedback?: (r: unknown) => string;
  validateOutput?: () => Promise<{ error?: string } | undefined>;
}

const mockRunMultiStepTask =
  mock<
    (
      opts: Record<string, unknown>,
    ) => Promise<{ results: unknown[]; approved: boolean }>
  >();

// What the mock returns for the review step result + final `approved` flag.
let nextReviewResult: {
  ready: boolean;
  feedback: string;
  suggestions: string[];
} = {
  ready: true,
  feedback: "Approved",
  suggestions: [],
};
let nextApproved = true;
let lastCapturedSteps: CapturedStep[] = [];
/** The full options object handed to runMultiStepTask on the last call. */
let lastCapturedOpts: Record<string, unknown> = {};
/** Per-step effective prompt (post-`beforeStepPrompt`-hook) from the last call. */
let lastEffectivePrompts: Record<string, string> = {};

// ── reviewRunner mock (B3 migration) ──────────────────────────────────────
// Captures the executeSpec, reviewSpec, and options passed to reviewRunner.
// Returns a mock Runner function whose resolve value can be controlled per-test.
let lastReviewRunnerExecuteSpec: Record<string, unknown> = {};
let lastReviewRunnerReviewSpec: Record<string, unknown> = {};
let lastReviewRunnerOptions: Record<string, unknown> = {};
/** The runner function returned by the mock reviewRunner. */
let mockReviewRunnerFn: ((ctx: unknown) => Promise<{ status: string }>) & {
  mockClear: () => void;
  mock: { calls: unknown[][] };
} = mock().mockResolvedValue({ status: "completed" });

const mockReviewRunner = mock(
  (executeSpec: unknown, reviewSpec: unknown, options?: unknown) => {
    lastReviewRunnerExecuteSpec = executeSpec as Record<string, unknown>;
    lastReviewRunnerReviewSpec = reviewSpec as Record<string, unknown>;
    lastReviewRunnerOptions = (options ?? {}) as Record<string, unknown>;
    mockReviewRunnerFn = mock().mockResolvedValue({ status: "completed" });
    return mockReviewRunnerFn;
  },
);

// ── RunnerPool mock (B3 migration) ────────────────────────────────────────
// Captures the options passed to the RunnerPool constructor, particularly
// `getRunnerForTask`. Returns a mock pool with a controllable `run()` method.
let lastRunnerPoolOpts: Record<string, unknown> = {};
/** The mock run function returned by the mock RunnerPool. */
let mockPoolRunFn: ReturnType<typeof mock> = mock().mockResolvedValue({
  completedTasks: 1,
  failedTasks: 0,
});
/** Controls what the mock RunnerPool.run() resolves to (set per-test before calling planningPhase). */
let nextPoolResult: { completedTasks: number; failedTasks: number } = {
  completedTasks: 1,
  failedTasks: 0,
};

const mockRunnerPoolConstructor = mock((opts: unknown) => {
  lastRunnerPoolOpts = opts as Record<string, unknown>;
  mockPoolRunFn = mock().mockResolvedValue(nextPoolResult);
  return { run: mockPoolRunFn };
});

mockRunMultiStepTask.mockImplementation(async (opts) => {
  const steps = opts.steps as RawStep[];
  lastCapturedSteps = [];
  lastCapturedOpts = opts;
  lastEffectivePrompts = {};
  const results: unknown[] = [];

  // The engine resolves each step's (possibly lazy) prompt, then — when a
  // hookRegistry with `beforeStepPrompt` subscribers is threaded in — passes
  // the resolved prompt through the pipeline hook and uses the return value.
  // We mirror that here so tests can assert on the EFFECTIVE prompt.
  const hookRegistry = opts.hookRegistry as
    | {
        hasSubscribers?: (name: string) => boolean;
        invokePipeline?: (
          name: string,
          value: unknown,
          args: unknown,
          ctx: unknown,
        ) => Promise<unknown>;
      }
    | undefined;
  const taskFiles = (opts.files as string[] | undefined) ?? [];

  for (const step of steps) {
    const promptText =
      typeof step.prompt === "function"
        ? await step.prompt([...results], { attempt: 0 })
        : step.prompt;

    const hasHook = !!hookRegistry?.hasSubscribers?.("beforeStepPrompt");
    const effectivePrompt = hasHook
      ? String(
          await hookRegistry!.invokePipeline!(
            "beforeStepPrompt",
            promptText,
            // The engine synthesizes a Task carrying `files` and passes it to the hook.
            {
              task: { files: taskFiles },
              step: { name: step.stepName },
              prompt: promptText,
              cwd: opts.cwd,
            },
            { cwd: opts.cwd },
          ),
        )
      : promptText;
    lastEffectivePrompts[step.stepName] = effectivePrompt;

    lastCapturedSteps.push({
      stepName: step.stepName,
      profileId: step.profileId,
      promptText,
      effectivePrompt,
      isReadOnly: step.isReadOnly,
      allowedWriteDirs: step.allowedWriteDirs,
      schema: step.schema,
      isApproved: step.isApproved,
      getFeedback: step.getFeedback,
      validateOutput: step.validateOutput,
    });
    if (typeof step.validateOutput === "function") await step.validateOutput();
    if (step.stepName === "review-plan") results.push(nextReviewResult);
    else results.push(undefined);
  }
  return { results, approved: nextApproved };
});

mock.module("@harms-haus/engin-engine", () => ({
  ...createEnginMock(),
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  runMultiStepTask: mockRunMultiStepTask,
  reviewRunner: mockReviewRunner,
  RunnerPool: mockRunnerPoolConstructor,
}));

// Dynamic import after mock is set up
const { planningPhase, getPlanPath, getArtifactsDir } =
  await import("./planning");
import type { Plan } from "./schemas";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMockTracker(): WorkflowStatusTracker {
  return {
    auditLog: { append: mock(() => {}) },
    setWorkflowData: mock(() => {}),
    recordAgentSpawn: mock(() => {}),
    incrementAgentCount: mock(() => {}),
  } as unknown as WorkflowStatusTracker;
}

function makeStatusCallbacksSpy() {
  return {
    onAgentSpawn: mock(() => {}),
    onAgentComplete: mock(() => {}),
    onDecision: mock(() => {}),
    onTaskRegister: mock(() => {}),
    onTaskStart: mock(() => {}),
    onTaskComplete: mock(() => {}),
    onTaskRejected: mock(() => {}),
    onStepStart: mock(() => {}),
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

/** Read the live planning.ts source text (for deletion / import assertions). */
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
    mockRunMultiStepTask.mockClear();
    lastCapturedSteps = [];
    lastCapturedOpts = {};
    lastEffectivePrompts = {};
    nextReviewResult = { ready: true, feedback: "Approved", suggestions: [] };
    nextApproved = true;

    // B3 migration mock resets
    mockReviewRunner.mockClear();
    mockRunnerPoolConstructor.mockClear();
    lastReviewRunnerExecuteSpec = {};
    lastReviewRunnerReviewSpec = {};
    lastReviewRunnerOptions = {};
    mockReviewRunnerFn = mock().mockResolvedValue({ status: "completed" });
    lastRunnerPoolOpts = {};
    mockPoolRunFn = mock().mockResolvedValue({
      completedTasks: 1,
      failedTasks: 0,
    });
    nextPoolResult = { completedTasks: 1, failedTasks: 0 };
  });

  const planStep = () => lastCapturedSteps.find((s) => s.stepName === "plan")!;
  const reviewStep = () =>
    lastCapturedSteps.find((s) => s.stepName === "review-plan")!;
  const capturedOpts = () => lastCapturedOpts;
  const effectivePrompt = (stepName: string) => lastEffectivePrompts[stepName];

  // ── reviewRunner + RunnerPool wiring ─────────────────────────────────────

  it("runs plan + review as ONE reviewRunner composed task dispatched via RunnerPool", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        makeMockTracker(),
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      // reviewRunner composes plan + review-plan into a single loop runner.
      expect(mockReviewRunner).toHaveBeenCalledTimes(1);
      // RunnerPool is constructed once and runs the planning task.
      expect(mockRunnerPoolConstructor).toHaveBeenCalledTimes(1);
      // The planning task is registered with the expected id / title.
      const tasks = (
        lastRunnerPoolOpts.taskTracker as MockTaskTracker
      ).getAllTasks();
      expect(tasks.find((t) => t.id === "planning")).toBeDefined();
      expect(tasks.find((t) => t.title === "Plan & Review")).toBeDefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("configures the plan execute spec (filesystem output, no schema)", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        makeMockTracker(),
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      const spec = lastReviewRunnerExecuteSpec;
      expect(spec.profile).toBe("planner");
      expect(spec.outputMode).toBe("filesystem");
      expect(spec.isReadOnly).toBe(false);
      expect(spec.schema).toBeUndefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("configures the review spec (read-only, structured, PlanReviewSchema)", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        makeMockTracker(),
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

  it("passes apiKeys, onStatus, signal, and rendererRegistry through", async () => {
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
        makeMockTracker(),
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

      expect(lastRunnerPoolOpts.apiKeys).toBe(apiKeys);
      expect(lastRunnerPoolOpts.onStatus).toBe(onStatus);
      expect(lastRunnerPoolOpts.signal).toBe(abortController.signal);
      expect(lastRunnerPoolOpts.rendererRegistry).toBe(fakeRegistry);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Plan step prompt ────────────────────────────────────────────────────

  it("tells the planner to write the plan to the artifacts file path", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        makeMockTracker(),
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
      expect(prompt).toContain("Do NOT output the plan as text");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── DELETED duplicate inlining code ──────────────────────────────────────
  //
  // §5 item #4: the planner/plan-reviewer must NOT carry their own copy of the
  // engine's buildPrompt file-inlining logic. These assertions guard against
  // the duplication creeping back in.

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
      // `open` (node:fs/promises) was only used by readContextFile.
      expect(src).not.toMatch(
        /import\s*\{[^}]*\bopen\b[^}]*\}\s*from\s*["']node:fs\/promises["']/,
      );
      // `extname` / `isAbsolute` (node:path) were only used by readContextFile.
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
  //
  // Previously planning.ts inlined scouting-file contents into the prompt
  // itself (formatScoutingFilesSection). Now it threads the files onto the
  // planning task so the engine's default beforeStepPrompt / collectContext
  // hooks inline them — eliminating the duplicated inlining logic.

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
          makeMockTracker(),
          ["/profiles"],
          "Research",
          ["src/api.ts"],
          "Task",
          cwd,
          workDir,
        );

        const tasks = (
          lastRunnerPoolOpts.taskTracker as MockTaskTracker
        ).getAllTasks();
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
          makeMockTracker(),
          ["/profiles"],
          "Research",
          [],
          "Task",
          cwd,
          workDir,
        );

        const tasks = (
          lastRunnerPoolOpts.taskTracker as MockTaskTracker
        ).getAllTasks();
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
          makeMockTracker(),
          ["/profiles"],
          "Research",
          ["src/api.ts"],
          "Task",
          cwd,
          workDir,
        );

        // The prompt built by planningPhase itself must be free of inlined
        // file contents — that is now the engine's job.
        const prompt = lastReviewRunnerExecuteSpec.prompt as string;
        expect(prompt).not.toContain("Key files from scouting");
        expect(prompt).not.toContain("### src/api.ts");
        expect(prompt).not.toContain('export const API = "v1";');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("threads task.files + hookRegistry so the engine beforeStepPrompt hook can inline them", async () => {
      // With `files` threaded onto the task AND a `hookRegistry` carrying a
      // beforeStepPrompt subscriber, the engine's hook would inline file
      // contents into the effective session prompt. Since the RunnerPool is
      // mocked here we verify the preconditions: files on the task AND
      // hookRegistry threaded into the pool options.
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(),
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

        const tasks = (
          lastRunnerPoolOpts.taskTracker as MockTaskTracker
        ).getAllTasks();
        const planningTask = tasks.find((t) => t.id === "planning")!;
        expect(planningTask.files).toContain("src/api.ts");
        expect(lastRunnerPoolOpts.hookRegistry).toBeDefined();
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ── hookRegistry threading ──────────────────────────────────────────────

  describe("hookRegistry threading (enables the engine beforeStepPrompt default)", () => {
    it("forwards the hookRegistry to the RunnerPool", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      const fakeHookRegistry = { hasSubscribers: () => false } as never;
      try {
        await planningPhase(
          makeMockTracker(),
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

        expect(lastRunnerPoolOpts.hookRegistry).toBe(fakeHookRegistry);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("omits hookRegistry from the RunnerPool when none is provided", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(),
          ["/profiles"],
          "Research",
          [],
          "Task",
          "/cwd",
          workDir,
        );

        expect(lastRunnerPoolOpts.hookRegistry).toBeUndefined();
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
        makeMockTracker(),
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
        makeMockTracker(),
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

  it("calls setWorkflowData with the plan read from the file", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const tracker = makeMockTracker();
      await planningPhase(
        tracker,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );
      expect(tracker.setWorkflowData).toHaveBeenCalledWith({
        plan: SAMPLE_PLAN,
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("does NOT manually append a structured_output event for the plan (the default auditor handles it)", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const tracker = makeMockTracker();
      await planningPhase(
        tracker,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
      );

      // The audit migration deleted the manual
      // `auditLog.append(structuredOutputEvent("planner", …))`; the plan's
      // structured_output event now lands via the engine's default auditor.
      // With the engine mocked here no auditor fires, so append must NOT
      // receive a structured_output event.
      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "structured_output" }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Decision / audit (final review outcome) ────────────────────────────

  it("fires onDecision with plan_approved (and no longer manually audits it) when the review approves", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      // B3: the mock RunnerPool resolves with completedTasks=1, failedTasks=0.
      // planningPhase derives `approved` from the pool outcome. The review
      // feedback text is internal to the reviewRunner and not propagated,
      // so the reasoning string is empty.
      nextPoolResult = { completedTasks: 1, failedTasks: 0 };
      const onStatus = makeStatusCallbacksSpy();
      const tracker = makeMockTracker();

      await planningPhase(
        tracker,
        ["/profiles"],
        "Research",
        [],
        "Task",
        "/cwd",
        workDir,
        undefined,
        onStatus,
      );

      // The onStatus.onDecision STORE callback (TUI) still fires …
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: "plan-reviewer",
        decision: "plan_approved",
        reasoning: "",
      });
      // … but the manual `auditLog.append(decisionEvent(…))` is gone: the
      // decision now lands via the engine's default auditor. With the engine
      // mocked here no auditor fires, so append must NOT receive a decision event.
      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "decision" }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fires onDecision with plan_rejected when the review exhausts retries (audit handled by the engine auditor)", async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      // B3: the mock RunnerPool resolves with failedTasks=1 (reviewRunner
      // exhausted its rounds). planningPhase derives `rejected` from the
      // pool outcome.
      nextPoolResult = { completedTasks: 0, failedTasks: 1 };
      const onStatus = makeStatusCallbacksSpy();
      const tracker = makeMockTracker();

      // Even on exhaustion, planningPhase proceeds with the captured plan.
      const result = await planningPhase(
        tracker,
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
  // B3 MIGRATION TESTS (kb-14) — expected to FAIL until planning.ts is
  // updated to use reviewRunner + RunnerPool instead of runMultiStepTask.
  // ═══════════════════════════════════════════════════════════════════════

  describe("planningPhase B3 migration (reviewRunner + RunnerPool)", () => {
    // ── 1. Import contract ────────────────────────────────────────────────

    it("1. imports reviewRunner, singleSession, RunnerPool and NOT runMultiStepTask", () => {
      const src = planningSource();
      // Post-migration: must import the new runner primitives
      expect(src).toMatch(/\breviewRunner\b/);
      expect(src).toMatch(/\bRunnerPool\b/);
      // runMultiStepTask MUST be removed
      expect(src).not.toMatch(/\brunMultiStepTask\b/);
    });

    // ── 2. runMultiStepTask not called ────────────────────────────────────

    it("2. does NOT call runMultiStepTask during planning", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(),
          ["/profiles"],
          "Research",
          [],
          "Task",
          "/cwd",
          workDir,
        );
        // After B3 migration, the runMultiStepTask mock must never fire
        expect(mockRunMultiStepTask).not.toHaveBeenCalled();
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    // ── 3. reviewRunner composition ───────────────────────────────────────

    it("3. composes plan singleSession (filesystem) + review-plan singleSession (structured) via reviewRunner", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(),
          ["/profiles"],
          "Research results...",
          [],
          "Implement X",
          "/cwd",
          workDir,
        );

        // reviewRunner must be called exactly once with the two specs
        expect(mockReviewRunner).toHaveBeenCalledTimes(1);

        // Execute spec = plan step with filesystem output
        expect(lastReviewRunnerExecuteSpec).toMatchObject({
          profile: "planner",
          outputMode: "filesystem",
        });
        // The plan prompt should contain the task/research and the path
        const execPrompt = lastReviewRunnerExecuteSpec.prompt as string;
        expect(execPrompt).toContain("planning agent");
        expect(execPrompt).toContain("Implement X");
        expect(execPrompt).toContain("Research results...");

        // Review spec = review-plan step with structured output
        expect(lastReviewRunnerReviewSpec).toMatchObject({
          profile: "plan-reviewer",
          outputMode: "structured",
        });
        // Must carry the PlanReviewSchema for {approved, feedback}
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

    // ── 4. RunnerPool construction ────────────────────────────────────────

    it("4. constructs RunnerPool with getRunnerForTask returning the reviewRunner", async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(),
          ["/profiles"],
          "Research",
          [],
          "Task",
          "/cwd",
          workDir,
        );

        // RunnerPool constructor must be called exactly once
        expect(mockRunnerPoolConstructor).toHaveBeenCalledTimes(1);

        // Options must include getRunnerForTask
        const opts = lastRunnerPoolOpts;
        expect(opts.getRunnerForTask).toBeDefined();
        expect(typeof opts.getRunnerForTask).toBe("function");

        // getRunnerForTask invoked with the planning task must return the
        // same runner function that reviewRunner returned.
        const getRunner = opts.getRunnerForTask as (task: {
          id: string;
        }) => unknown;
        const runner = getRunner({ id: "planning" });
        // The mock reviewRunner returns mockReviewRunnerFn; getRunnerForTask
        // should wire through to that same function.
        expect(runner).toBe(mockReviewRunnerFn);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    // ── 5. Coverage preservation ──────────────────────────────────────────

    it("5. preserves coverage: plan produced (filesystem), reviewed, loop retries on rejection", async () => {
      // Provide a pre-written plan.json so the OLD code path (runMultiStepTask
      // with lazy review prompt) doesn't crash trying to read a missing file.
      // Once migration lands, the reviewRunner owns the loop and this fallback
      // is irrelevant; the test then verifies the reviewRunner spec shapes.
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(),
          ["/profiles"],
          "Research results...",
          [],
          "Implement X",
          "/cwd",
          workDir,
        );

        // The reviewRunner execute spec must carry the full planner prompt
        // including the plan artifact path and write-instructions
        expect(lastReviewRunnerExecuteSpec.profile).toBe("planner");
        const execPrompt = lastReviewRunnerExecuteSpec.prompt as string;
        expect(execPrompt).toContain("`write`");
        expect(execPrompt).toContain("plan.json");
        expect(execPrompt).toContain("sandboxed");
        expect(execPrompt).toContain("Do NOT output the plan as text");

        // The execute outputMode 'filesystem' tells the session layer not to
        // expect a text/structured response from the planner — it wrote a file.
        expect(lastReviewRunnerExecuteSpec.outputMode).toBe("filesystem");

        // The review spec must define a structured schema that produces
        // {approved: boolean, feedback?: string} — the reviewRunner checks
        // `result.data.approved === true` to decide pass/fail.
        expect(lastReviewRunnerReviewSpec.outputMode).toBe("structured");
        expect(lastReviewRunnerReviewSpec.schema).toBeDefined();

        // The review prompt must instruct the reviewer to evaluate the plan
        const reviewPrompt = lastReviewRunnerReviewSpec.prompt as string;
        expect(reviewPrompt).toContain("reviewing an implementation plan");
        expect(reviewPrompt).toContain("Approve the plan if");

        // maxRounds controls the retry loop inside reviewRunner
        expect(lastReviewRunnerOptions.maxRounds).toBeGreaterThanOrEqual(1);

        // On the retry path, reviewRunner appends rejection feedback to the
        // execute prompt. The spec prompt must NOT contain feedback references
        // (that's added dynamically by reviewRunner, not baked into the spec).
        expect(execPrompt).not.toContain("Review feedback");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});
