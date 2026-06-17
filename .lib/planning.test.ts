// ─── Planning Phase Tests ────────────────────────────────────────────────────
//
// Tests for planning.ts. After the file-output refactor, the planner WRITES
// plan.json (rather than returning structured text), so planningPhase reads the
// artifact back via a `validateOutput` gate passed to runStepTask. The mock
// runStepTask honours that gate by invoking it (happy path), and tests pre-write
// the plan.json the planner would have produced.

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

const mockRunStepTask = mock<(opts: Record<string, unknown>) => Promise<unknown>>();
// Mimic the real runStepTask: when a validateOutput gate is supplied, invoke it
// once (happy path) so planningPhase can read back the plan file the test set up.
mockRunStepTask.mockImplementation(async (opts) => {
  if (typeof opts.validateOutput === 'function') {
    await opts.validateOutput();
  }
  // Generic blob for the plan-reviewer (which still returns structured output).
  return {
    topics: [],
    tasks: [],
    strategy: '',
    ready: true,
    research: 'Mock research',
    gaps: [],
    feedback: 'Mock feedback',
    suggestions: [],
  };
});

mock.module('@harms-haus/engin', () => ({
  ...createEnginMock(),
  LanePool: MockLanePool,
  TaskTracker: MockTaskTracker,
  runStepTask: mockRunStepTask,
}));

// Dynamic import after mock is set up
const { planningPhase, planReviewPhase, getPlanPath, getArtifactsDir } = await import('./planning');
import type { Plan, PlanReview } from './schemas';

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
    // Pretty-printed, the way a planner would actually write it.
    writeFileSync(getPlanPath(workDir), JSON.stringify(plan, null, 2));
  }
  return workDir;
}

// ─── Tests: planningPhase ───────────────────────────────────────────────────

describe('planningPhase', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  // ─── runStepTask options ──────────────────────────────────────────────────

  it('runs the planner as a NON-read-only task with a write sandbox and no schema', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        makeMockTracker(), ['/profiles'], 'Research results...', [], 'Implement feature X', '/cwd', workDir,
      );

      const opts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.taskId).toBe('planner');
      expect(opts.phaseId).toBe('planning');
      expect(opts.stepName).toBe('plan');
      expect(opts.profileId).toBe('planner');
      expect(opts.isReadOnly).toBe(false);
      expect(opts.schema).toBeUndefined();
      expect(opts.allowedWriteDirs).toEqual([getArtifactsDir(workDir)]);
      expect(typeof opts.validateOutput).toBe('function');
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
        undefined, undefined, apiKeys, onStatus, abortController.signal, fakeRegistry as never,
      );

      const opts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.apiKeys).toBe(apiKeys);
      expect(opts.onStatus).toBe(onStatus);
      expect(opts.signal).toBe(abortController.signal);
      expect(opts.rendererRegistry).toBe(fakeRegistry);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ─── Prompt contents ──────────────────────────────────────────────────────

  it('tells the planner to write the plan to the artifacts file path', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(
        makeMockTracker(), ['/profiles'], 'Research results...', [], 'Implement feature X', '/cwd', workDir,
      );

      const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
      expect(prompt).toContain('planning agent');
      expect(prompt).toContain('Implement feature X');
      expect(prompt).toContain('Research results...');
      expect(prompt).toContain(getPlanPath(workDir));
      expect(prompt).toContain('artifacts');
      expect(prompt).toContain('write');
      expect(prompt).toContain('sandboxed');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does NOT instruct the planner to respond with JSON text', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

      const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
      expect(prompt).toContain('Do NOT output the plan as text');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ─── Scouting file-context inlining ───────────────────────────────────────

  describe('scouting file-context inlining', () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'planning-files-'));
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/api.ts'), 'export const API = "v1";\n');
      writeFileSync(join(cwd, 'src/util.ts'), 'export const id = () => 0;\n');
    });
    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    it('inlines the contents of the scouting files into the planner prompt', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(), ['/profiles'], 'Research', ['src/api.ts', 'src/util.ts'], 'Task', cwd, workDir,
        );

        const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
        expect(prompt).toContain('Key files from scouting');
        expect(prompt).toContain('### src/api.ts');
        expect(prompt).toContain('export const API = "v1";');
        expect(prompt).toContain('### src/util.ts');
        expect(prompt).toContain('do NOT spend tool calls re-reading these');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('omits the files section entirely when no files are provided', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', cwd, workDir);

        const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
        expect(prompt).not.toContain('Key files from scouting');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Plan review feedback ─────────────────────────────────────────────────

  describe('with plan review feedback', () => {
    it('includes feedback in the prompt when provided', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir, 'The plan lacks detail',
        );

        const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
        expect(prompt).toContain('Previous plan was rejected');
        expect(prompt).toContain('The plan lacks detail');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('includes suggestions in the prompt when provided with feedback', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(
          makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir,
          'Needs improvement', ['Add error handling', 'Add tests'],
        );

        const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
        expect(prompt).toContain('Specific suggestions:');
        expect(prompt).toContain('- Add error handling');
        expect(prompt).toContain('- Add tests');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('omits feedback section when no feedback provided', async () => {
      const workDir = makeWorkDir(SAMPLE_PLAN);
      try {
        await planningPhase(makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir);

        const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
        expect(prompt).not.toContain('Previous plan was rejected');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Read-back & workflow data ────────────────────────────────────────────

  it('reads the written plan.json back and returns it as the validated Plan', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      const result = await planningPhase(
        makeMockTracker(), ['/profiles'], 'Research', [], 'Task', '/cwd', workDir,
      );

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
        expect.objectContaining({
          type: 'structured_output',
          agentId: 'planner',
          output: SAMPLE_PLAN,
        }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // NOTE: the in-session validation retry loop (validateOutput failing →
  // re-prompt up to 3×) lives in runStepTask and is covered by the engine's
  // phase-tasks tests, not here — the mocked runStepTask simulates success.
});

// ─── Tests: planReviewPhase ─────────────────────────────────────────────────

describe('planReviewPhase', () => {
  beforeEach(() => {
    mockRunStepTask.mockClear();
  });

  it('calls runStepTask with correct options', async () => {
    const workDir = makeWorkDir({ tasks: [], strategy: 'Plan' });
    try {
      const reviewResult: PlanReview = { ready: true, feedback: 'Looks good', suggestions: [] };
      mockRunStepTask.mockResolvedValueOnce(reviewResult);

      const result = await planReviewPhase(
        makeMockTracker(), ['/profiles'], workDir, 'Research', [], 'Task', '/cwd',
      );

      expect(result).toBe(reviewResult);
      const opts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.taskId).toBe('plan-reviewer');
      expect(opts.phaseId).toBe('planning');
      expect(opts.stepName).toBe('review-plan');
      expect(opts.profileId).toBe('plan-reviewer');
      expect(opts.isReadOnly).toBe(true);
      expect(opts.schema).toBeDefined(); // reviewer still uses structured output
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('reads plan.json from the workDir and inlines its contents into the reviewer prompt', async () => {
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'OK', suggestions: [] });

      await planReviewPhase(
        makeMockTracker(), ['/profiles'], workDir, 'Research', [], 'Task', '/cwd',
      );

      const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
      expect(prompt).toContain('reviewing an implementation plan');
      expect(prompt).toContain('Research');
      // The plan file contents (raw JSON) are inlined, not a JS-stringified object.
      expect(prompt).toContain('Proposed plan (written by the planner)');
      expect(prompt).toContain('"id": "task-1"');
      expect(prompt).toContain('"strategy": "Step by step"');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('throws when the plan file is missing', async () => {
    const workDir = makeWorkDir(); // no plan.json
    try {
      await expect(
        planReviewPhase(makeMockTracker(), ['/profiles'], workDir, 'Research', [], 'Task', '/cwd'),
      ).rejects.toThrow(/no plan file found/);
      // And it must not have spawned the reviewer at all.
      expect(mockRunStepTask).not.toHaveBeenCalled();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('passes apiKeys, onStatus, signal, and rendererRegistry through', async () => {
    const workDir = makeWorkDir({ tasks: [], strategy: '' });
    try {
      const apiKeys = { openai: 'sk-test' };
      const onStatus = makeStatusCallbacksSpy();
      const abortController = new AbortController();
      const fakeRegistry = { renderers: new Map(), register: mock(() => {}), get: mock(() => {}), render: mock(() => {}) };
      mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: '', suggestions: [] });

      await planReviewPhase(
        makeMockTracker(), ['/profiles'], workDir, 'Research', [], 'Task', '/cwd',
        apiKeys, onStatus, abortController.signal, fakeRegistry as never,
      );

      const opts = mockRunStepTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts.apiKeys).toBe(apiKeys);
      expect(opts.onStatus).toBe(onStatus);
      expect(opts.signal).toBe(abortController.signal);
      expect(opts.rendererRegistry).toBe(fakeRegistry);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('inlines the scouting files into the reviewer prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'planreview-files-'));
    const workDir = makeWorkDir(SAMPLE_PLAN);
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/api.ts'), 'export const API = "v1";\n');
      mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'OK', suggestions: [] });

      await planReviewPhase(
        makeMockTracker(), ['/profiles'], workDir, 'Research', ['src/api.ts'], 'Task', cwd,
      );

      const prompt = mockRunStepTask.mock.calls[0]![0]!.prompt as string;
      expect(prompt).toContain('Key files from scouting');
      expect(prompt).toContain('### src/api.ts');
      expect(prompt).toContain('export const API = "v1";');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ─── onDecision callback ──────────────────────────────────────────────────

  describe('onDecision callback', () => {
    it('fires onDecision with plan_approved when ready is true', async () => {
      const workDir = makeWorkDir({ tasks: [], strategy: '' });
      try {
        const onStatus = makeStatusCallbacksSpy();
        mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'Approved', suggestions: [] });

        await planReviewPhase(
          makeMockTracker(), ['/profiles'], workDir, 'Research', [], 'Task', '/cwd', undefined, onStatus,
        );

        expect(onStatus.onDecision).toHaveBeenCalledWith({
          agentId: 'plan-reviewer',
          decision: 'plan_approved',
          reasoning: 'Approved',
        });
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('fires onDecision with plan_rejected when ready is false', async () => {
      const workDir = makeWorkDir({ tasks: [], strategy: '' });
      try {
        const onStatus = makeStatusCallbacksSpy();
        mockRunStepTask.mockResolvedValueOnce({ ready: false, feedback: 'Missing details', suggestions: ['Add more detail'] });

        await planReviewPhase(
          makeMockTracker(), ['/profiles'], workDir, 'Research', [], 'Task', '/cwd', undefined, onStatus,
        );

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

  // ─── Audit log ────────────────────────────────────────────────────────────

  it('appends a decision event to the audit log', async () => {
    const workDir = makeWorkDir({ tasks: [], strategy: '' });
    try {
      const tracker = makeMockTracker();
      mockRunStepTask.mockResolvedValueOnce({ ready: true, feedback: 'Plan approved', suggestions: [] });

      await planReviewPhase(tracker, ['/profiles'], workDir, 'Research', [], 'Task', '/cwd');

      expect(tracker.auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decision',
          agentId: 'plan-reviewer',
          decision: 'plan_approved',
          reasoning: 'Plan approved',
        }),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
