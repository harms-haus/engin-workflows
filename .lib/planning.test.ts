// ─── Planning Phase Tests ────────────────────────────────────────────────────
//
// Planning is ONE task with TWO steps (plan → review-plan), run via the
// engine's runMultiStepTask. The plan step writes plan.json (validated by a
// `validateOutput` gate); the review step reads it back (its prompt is a lazy
// function so the file exists by the time it runs) and gates approval via
// `isApproved`. The replan-on-rejection loop lives inside runMultiStepTask and
// is covered by the engine's phase-tasks tests; here we assert that planningPhase
// wires the two steps correctly.
//
// These tests are written TEST-FIRST for the "delete duplicate prompt-inlining"
// refactor (§5 item #4). They assert the POST-REFACTOR contract:
//
//   1. The duplicated file-inlining code (CONTEXT_FILE_MAX_BYTES, LANG_BY_EXT,
//      BINARY_EXTS, readContextFile, formatScoutingFilesSection) is GONE from
//      planning.ts.
//   2. The scouting files are handed to runMultiStepTask as `files` (so the
//      engine's default `beforeStepPrompt` / `collectContext` hooks inline them),
//      NOT inlined into the prompt locally.
//   3. A `hookRegistry` is threaded into runMultiStepTask so the engine's
//      default prompt-context hook fires.
//   4. The `structuredOutputEvent` / `decisionEvent` helper imports are REMOVED
//      and the manual `auditLog.append(…)` calls deleted — the engine's default
//      auditor (registered in runSpir, task-17) now produces those events.
//
// The mock runMultiStepTask mimics just enough of the real behaviour to let us
// assert prompt contents, the plan read-back, the `files`/`hookRegistry` wiring,
// AND the engine-default inlining effect (it invokes a threaded `beforeStepPrompt`
// hook when one is present, exactly like the engine).
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import type { StatusCallbacks, WorkflowStatusTracker } from '@harms-haus/engin-engine';
import { createEnginMock } from './engin-mock';

// ─── Mock @harms-haus/engin ────────────────────────────────────────────────

class MockTaskTracker {
  private tasks: Map<string, Record<string, unknown>> = new Map();

  addTask(task: Record<string, unknown>) {
    if (this.tasks.has(task.id as string)) {
      throw new Error(`Task with id "${task.id}" already exists`);
    }
    this.tasks.set(task.id as string, { ...task, status: task.status ?? 'ready' });
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
  prompt: string | ((priorResults: unknown[], ctx: { attempt: number }) => Promise<string> | string);
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

const mockRunMultiStepTask = mock<(opts: Record<string, unknown>) => Promise<{ results: unknown[]; approved: boolean }>>();

// What the mock returns for the review step result + final `approved` flag.
let nextReviewResult: { ready: boolean; feedback: string; suggestions: string[] } = {
  ready: true,
  feedback: 'Approved',
  suggestions: [],
};
let nextApproved = true;
let lastCapturedSteps: CapturedStep[] = [];
/** The full options object handed to runMultiStepTask on the last call. */
let lastCapturedOpts: Record<string, unknown> = {};
/** Per-step effective prompt (post-`beforeStepPrompt`-hook) from the last call. */
let lastEffectivePrompts: Record<string, string> = {};

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
        invokePipeline?: (name: string, value: unknown, args: unknown, ctx: unknown) => Promise<unknown>;
      }
    | undefined;
  const taskFiles = (opts.files as string[] | undefined) ?? [];

  for (const step of steps) {
    const promptText = typeof step.prompt === 'function' ? await step.prompt([...results], { attempt: 0 }) : step.prompt;

    const hasHook = !!hookRegistry?.hasSubscribers?.('beforeStepPrompt');
    const effectivePrompt = hasHook
      ? String(
          await hookRegistry!.invokePipeline!(
            'beforeStepPrompt',
            promptText,
            // The engine synthesizes a Task carrying `files` and passes it to the hook.
            { task: { files: taskFiles }, step: { name: step.stepName }, prompt: promptText, cwd: opts.cwd },
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
    if (typeof step.validateOutput === 'function') await step.validateOutput();
    if (step.stepName === 'review-plan') results.push(nextReviewResult);
    else results.push(undefined);
  }
  return { results, approved: nextApproved };
});

mock.module('@harms-haus/engin-engine', () => ({
  ...createEnginMock(),
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  runMultiStepTask: mockRunMultiStepTask,
}));

// Dynamic import after mock is set up
const { planningPhase, getPlanPath, getArtifactsDir } = await import('./planning');
import type { Plan } from './schemas';

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
      id: 'task-1', title: 'Do thing', prompt: 'Implement',
      profile: 'implementer', files: ['src/main.ts'], is_code: true, dependencies: [],
    },
  ],
  strategy: 'Step by step',
};

/** Create a temp workDir and (optionally) pre-write a valid plan.json into it. */
function makeWorkDir(plan?: Plan): string {
  const workDir = mkdtempSync(join(tmpdir(), 'planning-wd-'));
  if (plan) {
    mkdirSync(getArtifactsDir(workDir), { recursive: true });
    writeFileSync(getPlanPath(workDir), JSON.stringify(plan, null, 2));
  }
  return workDir;
}

/** Read the live planning.ts source text (for deletion / import assertions). */
function planningSource(): string {
  return readFileSync(fileURLToPath(new URL('./planning.ts', import.meta.url)), 'utf-8');
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
      return name === 'beforeStepPrompt';
    },
    async invokeObserve() {},
    async invokeFirstWins() {
      return undefined;
    },
    async invokeAllRun() {
      return undefined;
    },
    async invokePipeline(name: string, value: unknown, args: unknown, ctx: unknown) {
      if (name !== 'beforeStepPrompt') return value as string;
      const files = ((args as { task?: { files?: string[] } })?.task?.files) ?? [];
      const cwd = (ctx as { cwd?: string } | null)?.cwd ?? '.';
      const blocks: string[] = [];
      for (const fp of files) {
        let content: string | null = null;
        try {
          content = readFileSync(isAbsolute(fp) ? fp : join(cwd, fp), 'utf-8');
        } catch {
          /* unreadable — skip, mirroring the engine default */
        }
        if (content != null) blocks.push(`### ${fp}\n\`\`\`typescript\n${content}\n\`\`\``);
      }
      if (blocks.length === 0) return value as string;
      return `${value}\n\n${blocks.join('\n\n')}`;
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('planningPhase', () => {
  beforeEach(() => {
    mockRunMultiStepTask.mockClear();
    lastCapturedSteps = [];
    lastCapturedOpts = {};
    lastEffectivePrompts = {};
    nextReviewResult = { ready: true, feedback: 'Approved', suggestions: [] };
    nextApproved = true;
  });

  const planStep = () => lastCapturedSteps.find((s) => s.stepName === 'plan')!;
  const reviewStep = () => lastCapturedSteps.find((s) => s.stepName === 'review-plan')!;
  const capturedOpts = () => lastCapturedOpts;
  const effectivePrompt = (stepName: string) => lastEffectivePrompts[stepName];

  // ── runMultiStepTask wiring ─────────────────────────────────────────────

  it('runs plan + review as ONE two-step task', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      expect(mockRunMultiStepTask).toHaveBeenCalledTimes(1);
      const opts = capturedOpts();
      expect(opts.taskId).toBe('planning');
      expect(opts.phaseId).toBe('planning');
      expect(opts.title).toBe('Plan & Review');
      expect(Array.isArray(opts.steps)).toBe(true);
      expect((opts.steps as RawStep[]).map((s) => s.stepName)).toEqual(['plan', 'review-plan']);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('configures the plan step (write sandbox, no schema, validateOutput gate)', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      const s = planStep();
      expect(s.profileId).toBe('planner');
      expect(s.isReadOnly).toBe(false);
      expect(s.allowedWriteDirs).toEqual([getArtifactsDir(workDir)]);
      expect(s.schema).toBeUndefined();
      expect(typeof s.validateOutput).toBe('function');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('configures the review step (read-only, schema, ready-gate, feedback extractor)', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      const s = reviewStep();
      expect(s.profileId).toBe('plan-reviewer');
      expect(s.isReadOnly).toBe(true);
      expect(s.schema).toBeDefined();
      expect(s.isApproved!({ ready: true })).toBe(true);
      expect(s.isApproved!({ ready: false })).toBe(false);
      // getFeedback folds suggestions into the feedback line.
      const fb = s.getFeedback!({ ready: false, feedback: 'vague', suggestions: ['add x', 'add y'] });
      expect(fb).toContain('vague');
      expect(fb).toContain('- add x');
      expect(fb).toContain('- add y');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('passes apiKeys, onStatus, signal, and rendererRegistry through', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const apiKeys = { openai: 'sk-test' };
      const onStatus = makeStatusCallbacksSpy();
      const abortController = new AbortController();
      const fakeRegistry = { renderers: new Map(), register: mock(() => {}), get: mock(() => {}), render: mock(() => {}) };

      await planningPhase(
        makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir,
        apiKeys, onStatus, abortController.signal, fakeRegistry as never,
      );

      const opts = capturedOpts();
      expect(opts.apiKeys).toBe(apiKeys);
      expect(opts.onStatus).toBe(onStatus);
      expect(opts.signal).toBe(abortController.signal);
      expect(opts.rendererRegistry).toBe(fakeRegistry);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Plan step prompt ────────────────────────────────────────────────────

  it('tells the planner to write the plan to the artifacts file path', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research results...', [], 'Implement feature X', '/cwd', workDir);

      const prompt = planStep().promptText;
      expect(prompt).toContain('planning agent');
      expect(prompt).toContain('Implement feature X');
      expect(prompt).toContain('Research results...');
      expect(prompt).toContain(getPlanPath(workDir));
      expect(prompt).toContain('sandboxed');
      expect(prompt).toContain('Do NOT output the plan as text');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── DELETED duplicate inlining code ──────────────────────────────────────
  //
  // §5 item #4: the planner/plan-reviewer must NOT carry their own copy of the
  // engine's buildPrompt file-inlining logic. These assertions guard against
  // the duplication creeping back in.

  describe('duplicate prompt-inlining code is removed', () => {
    it('no longer defines the duplicated inlining constants / helpers', () => {
      const src = planningSource();
      expect(src).not.toContain('CONTEXT_FILE_MAX_BYTES');
      expect(src).not.toContain('LANG_BY_EXT');
      expect(src).not.toContain('BINARY_EXTS');
      expect(src).not.toContain('readContextFile');
      expect(src).not.toContain('formatScoutingFilesSection');
      expect(src).not.toContain('inlineScoutingContext');
    });

    it('drops the fs/path imports that were only used by the deleted code', () => {
      const src = planningSource();
      // `open` (node:fs/promises) was only used by readContextFile.
      expect(src).not.toMatch(/import\s*\{[^}]*\bopen\b[^}]*\}\s*from\s*["']node:fs\/promises["']/);
      // `extname` / `isAbsolute` (node:path) were only used by readContextFile.
      expect(src).not.toMatch(/import\s*\{[^}]*\bextname\b[^}]*\}\s*from\s*["']node:path["']/);
      expect(src).not.toMatch(/import\s*\{[^}]*\bisAbsolute\b[^}]*\}\s*from\s*["']node:path["']/);
    });

    it('still keeps readFile / join (used by the surviving plan read-back helpers)', () => {
      const src = planningSource();
      expect(src).toMatch(/readFile/);
      expect(src).toMatch(/\bjoin\b/);
    });
  });

  // ── Scouting file context is DELEGATED to the engine ────────────────────
  //
  // Previously planning.ts inlined scouting-file contents into the prompt
  // itself (formatScoutingFilesSection). Now it must hand the files to
  // runMultiStepTask (`files` on the task) so the engine's default
  // beforeStepPrompt / collectContext hooks inline them — eliminating the
  // duplicated inlining logic.

  describe('scouting file context is delegated to the engine (no local inlining)', () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'planning-files-'));
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/api.ts'), 'export const API = "v1";\n');
    });
    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it('hands the scouting files to runMultiStepTask as opts.files', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', ['src/api.ts'], 'Task', cwd, workDir);

        const opts = capturedOpts();
        expect(opts.files).toEqual(['src/api.ts']);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('hands an empty files array when no scouting files were provided', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', cwd, workDir);

        expect(capturedOpts().files).toEqual([]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does NOT inline file contents into the locally-built planner prompt', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', ['src/api.ts'], 'Task', cwd, workDir);

        // The prompt built by planningPhase itself must be free of inlined
        // file contents — that is now the engine's job.
        const prompt = planStep().promptText;
        expect(prompt).not.toContain('Key files from scouting');
        expect(prompt).not.toContain('### src/api.ts');
        expect(prompt).not.toContain('export const API = "v1";');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('the engine default beforeStepPrompt hook inlines task.files into the effective prompt', async () => {
      // With `files` threaded onto the task AND a `hookRegistry` carrying a
      // beforeStepPrompt subscriber, the EFFECTIVE prompt (post-hook) must
      // contain the inlined file contents — proving the planner still gets
      // file context, now via the engine path rather than the local duplicate.
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(), ['/profiles'], 'Research', ['src/api.ts'], 'Task', cwd, workDir,
          undefined, undefined, undefined, undefined, makeInliningHookRegistry() as never,
        );

        const effective = effectivePrompt('plan');
        expect(effective).toContain('src/api.ts');
        expect(effective).toContain('export const API = "v1";');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ── hookRegistry threading ──────────────────────────────────────────────

  describe('hookRegistry threading (enables the engine beforeStepPrompt default)', () => {
    it('forwards the hookRegistry to runMultiStepTask', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      const fakeHookRegistry = { hasSubscribers: () => false } as never;
      try {
        await planningPhase(
          makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir,
          undefined, undefined, undefined, undefined, fakeHookRegistry,
        );

        expect(capturedOpts().hookRegistry).toBe(fakeHookRegistry);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('omits hookRegistry from runMultiStepTask when none is provided', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

        expect(capturedOpts().hookRegistry).toBeUndefined();
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ── helper imports removed (auditor migration done) ───────────────────

  describe('structuredOutputEvent / decisionEvent imports are removed (the engine auditor now handles it)', () => {
    it('no longer imports structuredOutputEvent or decisionEvent from ./helpers', () => {
      const src = planningSource();
      expect(src).not.toMatch(/from\s+["']\.\/helpers["']/);
      expect(src).not.toContain('structuredOutputEvent');
      expect(src).not.toContain('decisionEvent');
    });

    it('drops the resolved task-17 TODO', () => {
      const src = planningSource();
      expect(src).not.toContain('TODO(task-17)');
    });
  });

  // ── Review step prompt (lazy: reads plan.json at run time) ──────────────

  it('reads plan.json and inlines its contents into the reviewer prompt', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      const prompt = reviewStep().promptText;
      expect(prompt).toContain('reviewing an implementation plan');
      expect(prompt).toContain('Research');
      expect(prompt).toContain('Proposed plan (written by the planner)');
      // The raw JSON of the plan file is inlined.
      expect(prompt).toContain('"id": "task-1"');
      expect(prompt).toContain('"strategy": "Step by step"');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Read-back & workflow data ───────────────────────────────────────────

  it('reads the written plan.json back and returns it as the validated Plan', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const result = await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);
      expect(result).toEqual(SAMPLE_PLAN);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('calls setWorkflowData with the plan read from the file', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const tracker = makeMockTracker();
      await planningPhase(tracker, ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);
      expect(tracker.setWorkflowData).toHaveBeenCalledWith({ plan: SAMPLE_PLAN });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does NOT manually append a structured_output event for the plan (the default auditor handles it)', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const tracker = makeMockTracker();
      await planningPhase(tracker, ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      // The audit migration deleted the manual
      // `auditLog.append(structuredOutputEvent("planner", …))`; the plan's
      // structured_output event now lands via the engine's default auditor.
      // With the engine mocked here no auditor fires, so append must NOT
      // receive a structured_output event.
      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'structured_output' }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Decision / audit (final review outcome) ────────────────────────────

  it('fires onDecision with plan_approved (and no longer manually audits it) when the review approves', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      nextReviewResult = { ready: true, feedback: 'Looks good', suggestions: [] };
      nextApproved = true;
      const onStatus = makeStatusCallbacksSpy();
      const tracker = makeMockTracker();

      await planningPhase(tracker, ['/profiles'], 'Research', [], 'Task', '/cwd', workDir, undefined, onStatus);

      // The onStatus.onDecision STORE callback (TUI) still fires …
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'plan-reviewer',
        decision: 'plan_approved',
        reasoning: 'Looks good',
      });
      // … but the manual `auditLog.append(decisionEvent(…))` is gone: the
      // decision now lands via the engine's default auditor. With the engine
      // mocked here no auditor fires, so append must NOT receive a decision event.
      expect(tracker.auditLog.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decision' }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fires onDecision with plan_rejected when the review exhausts retries (audit handled by the engine auditor)', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      nextReviewResult = { ready: false, feedback: 'Missing details', suggestions: ['add more'] };
      nextApproved = false; // runMultiStepTask exhausted
      const onStatus = makeStatusCallbacksSpy();
      const tracker = makeMockTracker();

      // Even on exhaustion, planningPhase proceeds with the captured plan.
      const result = await planningPhase(tracker, ['/profiles'], 'Research', [], 'Task', '/cwd', workDir, undefined, onStatus);

      expect(result).toEqual(SAMPLE_PLAN);
      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'plan-reviewer',
        decision: 'plan_rejected',
        reasoning: 'Missing details',
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
