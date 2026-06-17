// ─── Planning Phase Tests ────────────────────────────────────────────────────
//
// Planning is now ONE task with TWO steps (plan → review-plan), run via the
// engine's runMultiStepTask. The plan step writes plan.json (validated by a
// `validateOutput` gate); the review step reads it back (its prompt is a lazy
// function so the file exists by the time it runs) and gates approval via
// `isApproved`. The replan-on-rejection loop lives inside runMultiStepTask and
// is covered by the engine's phase-tasks tests; here we assert that planningPhase
// wires the two steps correctly.
//
// The mock runMultiStepTask mimics just enough of the real behaviour to let us
// assert prompt contents and the plan read-back: it resolves each step's (lazy)
// prompt, invokes `validateOutput`, and returns a controllable review result.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatusCallbacks, WorkflowStatusTracker } from '@harms-haus/engin';
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

interface CapturedStep {
  stepName: string;
  profileId: string;
  promptText: string;
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

mockRunMultiStepTask.mockImplementation(async (opts) => {
  const steps = opts.steps as CapturedStep[];
  lastCapturedSteps = [];
  const results: unknown[] = [];
  for (const step of steps) {
    const promptText = typeof step.prompt === 'function' ? await step.prompt(results) : (step.prompt as string);
    lastCapturedSteps.push({
      stepName: step.stepName,
      profileId: step.profileId,
      promptText,
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

mock.module('@harms-haus/engin', () => ({
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('planningPhase', () => {
  beforeEach(() => {
    mockRunMultiStepTask.mockClear();
    lastCapturedSteps = [];
    nextReviewResult = { ready: true, feedback: 'Approved', suggestions: [] };
    nextApproved = true;
  });

  const planStep = () => lastCapturedSteps.find((s) => s.stepName === 'plan')!;
  const reviewStep = () => lastCapturedSteps.find((s) => s.stepName === 'review-plan')!;

  // ── runMultiStepTask wiring ─────────────────────────────────────────────

  it('runs plan + review as ONE two-step task', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      expect(mockRunMultiStepTask).toHaveBeenCalledTimes(1);
      const opts = mockRunMultiStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.taskId).toBe('planning');
      expect(opts.phaseId).toBe('planning');
      expect(opts.title).toBe('Plan & Review');
      expect(Array.isArray(opts.steps)).toBe(true);
      expect((opts.steps as CapturedStep[]).map((s) => s.stepName)).toEqual(['plan', 'review-plan']);
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

      const opts = mockRunMultiStepTask.mock.calls[0]![0] as Record<string, unknown>;
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

  // ── Scouting file-context inlining (plan step) ─────────────────────────

  describe('scouting file-context inlining', () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'planning-files-'));
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/api.ts'), 'export const API = "v1";\n');
    });
    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it('inlines the contents of the scouting files into the planner prompt', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', ['src/api.ts'], 'Task', cwd, workDir);

        const prompt = planStep().promptText;
        expect(prompt).toContain('Key files from scouting');
        expect(prompt).toContain('### src/api.ts');
        expect(prompt).toContain('export const API = "v1";');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('omits the files section entirely when no files are provided', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', cwd, workDir);

        expect(planStep().promptText).not.toContain('Key files from scouting');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
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

  it('appends a structured_output event with the read-back plan', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const tracker = makeMockTracker();
      await planningPhase(tracker, ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      expect(tracker.auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'structured_output', agentId: 'planner', output: SAMPLE_PLAN }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Decision / audit (final review outcome) ────────────────────────────

  it('fires onDecision + audit with plan_approved when the review approves', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      nextReviewResult = { ready: true, feedback: 'Looks good', suggestions: [] };
      nextApproved = true;
      const onStatus = makeStatusCallbacksSpy();
      const tracker = makeMockTracker();

      await planningPhase(tracker, ['/profiles'], 'Research', [], 'Task', '/cwd', workDir, undefined, onStatus);

      expect(onStatus.onDecision).toHaveBeenCalledWith({
        agentId: 'plan-reviewer',
        decision: 'plan_approved',
        reasoning: 'Looks good',
      });
      expect(tracker.auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decision', agentId: 'plan-reviewer', decision: 'plan_approved', reasoning: 'Looks good' }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('fires onDecision + audit with plan_rejected when the review exhausts retries', async () => {
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
