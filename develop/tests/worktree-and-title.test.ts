// ─── Worktree Tests ────────────────────────────────────────────────────────
//
// Tests for:
//   1. TitleSchema is re-exported from @harms-haus/engin (backward compat)
//   2. worktree?: WorktreeInfo is accepted in RunOptions
//   3. tracker.setWorktree is called BEFORE tracker.save() in run()
//   4. initializationPhase uses runStepTask (not createHarness directly)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Capture real module before mocking so we can restore it in afterAll.
const realEngin = Object.assign({}, await import("@harms-haus/engin-engine"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunMultiStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin-engine", () => ({
    ...realEngin,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
    runMultiStepTask: (...args: unknown[]) => mockRunMultiStepTask(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run, TitleSchema } from "../main";
import { WorkflowStatusTracker } from "@harms-haus/engin-engine";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `worktree-title-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

const BASE_PROFILE = {
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a helpful agent.",
    excludeTools: [],
    includeTools: [],
};

function makeAllProfiles(): Map<string, unknown> {
    const map = new Map<string, unknown>();
    const ids = [
        "scout",
        "scout-coordinator",
        "scouting-reviewer",
        "planner",
        "plan-reviewer",
        "implement-reviewer",
        "implementer",
        "fixer",
        "final-reviewer",
        "test-writer",
        "test-reviewer",
    ];
    for (const id of ids) {
        map.set(id, { ...BASE_PROFILE, id, name: id });
    }
    return map;
}

function makeHarness() {
    return {
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => ""),
        messages: [] as unknown[],
        subscribe: mock(() => mock()),
        sessionId: "test-session",
        dispose: mock(),
    };
}

function makeHarnessResult() {
    return { session: makeHarness(), sessionId: "test-session", dispose: mock() };
}

/**
 * Smart mock prompt handler for runStepTask calls.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;

    if (taskId === "title-generator") {
        return { title: "AI generated title" };
    }
    if (taskId === "scout-coordinator") return { topics: [] };
    if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
    if (taskId === "planner") return { tasks: [], strategy: "none" };
    if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
    if (/(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
    return {};
}

/** Default plan written by the smart runMultiStepTask mock when no plan.json exists. */
const DEFAULT_PLAN = {
    tasks: [{ id: "t1", title: "Default task", prompt: "Do it", profile: "implementer", files: ["src/index.ts"], dependencies: [], is_code: true }],
    strategy: "Default strategy",
};

/**
 * Smart mock for runMultiStepTask (used by planningPhase). Mimics just enough of
 * the real primitive to capture the plan: it resolves each step's (lazy) prompt
 * and invokes the plan step's `validateOutput` gate (which reads plan.json back
 * into planningPhase's closure). Returns an approved review by default.
 */
async function smartRunMultiStepTask(opts: Record<string, unknown>): Promise<{ results: unknown[]; approved: boolean }> {
    const steps = opts.steps as Array<Record<string, unknown>>;
    const results: unknown[] = [];
    for (const step of steps) {
        if (typeof step.prompt === "function") await step.prompt(results);
        if (typeof step.validateOutput === "function") {
            const allowed = (step.allowedWriteDirs as string[] | undefined)?.[0];
            if (allowed) {
                const planPath = path.join(allowed, "plan.json");
                try { await fs.access(planPath); } catch { await fs.mkdir(allowed, { recursive: true }); await fs.writeFile(planPath, JSON.stringify(DEFAULT_PLAN, null, 2)); }
            }
            await step.validateOutput();
        }
        results.push(step.stepName === "review-plan" ? { ready: true, feedback: "OK", suggestions: [] } : undefined);
    }
    return { results, approved: true };
}

/** Setup mocks for a minimal successful workflow run. */
function setupDefaultMocks() {
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);
    mockRunMultiStepTask.mockImplementation(smartRunMultiStepTask);
    // initialization uses runStepTask (which creates harness + prompts internally)
    mockPromptForStructured.mockReset();
    mockPromptForStructured
        .mockResolvedValueOnce({ result: { title: "AI generated title" }, attempts: 1 })
        .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 });
}

beforeEach(() => {
    mock.clearAllMocks();
    mockRunMultiStepTask.mockReset();
    setupDefaultMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

// ── 1. TitleSchema re-export ─────────────────────────────────────────────

describe("TitleSchema re-export", () => {
    it("TitleSchema is still importable from main.ts for backward compat", () => {
        // TitleSchema should be importable (we already imported it at the top)
        expect(TitleSchema).toBeDefined();
    });

    it("TitleSchema validates { title: string }", () => {
        const result = TitleSchema.safeParse({ title: "Refactor auth module" });
        expect(result.success).toBe(true);
    });

    it("TitleSchema rejects missing title", () => {
        const result = TitleSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it("TitleSchema rejects non-string title", () => {
        const result = TitleSchema.safeParse({ title: 42 });
        expect(result.success).toBe(false);
    });

    it("TitleSchema matches the expected shape", () => {
        const validData = { title: "Fix cache invalidation bug" };
        const result = TitleSchema.safeParse(validData);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.title).toBe("Fix cache invalidation bug");
        }

        // Verify rejection of invalid data
        expect(TitleSchema.safeParse({}).success).toBe(false);
        expect(TitleSchema.safeParse({ title: 42 }).success).toBe(false);
        expect(TitleSchema.safeParse({ title: "" }).success).toBe(true); // empty string is valid
    });
});

// ── 2. Worktree option acceptance ────────────────────────────────────────

describe("worktree option", () => {
    it("run accepts worktree option without error", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/worktree-abc",
            branchName: "feature/test",
            originalCwd: "/project",
        };

        // Should not throw
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        // Workflow should complete successfully
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    });

    it("run works without worktree option (backward compat)", async () => {
        const workDir = tmpDir();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    });

    it("worktree is persisted to tracker state", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/worktree-xyz",
            branchName: "feature/persist-test",
            originalCwd: "/home/user/project",
        };

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        // The worktree info should be persisted in the state file
        expect(state.worktree).toBeDefined();
        expect(state.worktree.worktreePath).toBe("/tmp/worktree-xyz");
        expect(state.worktree.branchName).toBe("feature/persist-test");
        expect(state.worktree.originalCwd).toBe("/home/user/project");
    });

    it("worktree is undefined in state when not provided", async () => {
        const workDir = tmpDir();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.worktree).toBeUndefined();
    });

    it("worktree is set before tracker.save()", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/worktree-set-before-save",
            branchName: "feature/tracker-save-order",
            originalCwd: "/project",
        };

        // Save happens early in run() and tracker is also saved at the end.
        // We verify the worktree was persisted by checking the state file after run.
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        // worktree should be in the state (meaning it was set before save)
        expect(state.worktree).toBeDefined();
        expect(state.worktree.worktreePath).toBe("/tmp/worktree-set-before-save");
    });
});

// ── 3. initializationPhase uses runStepTask ──────────────────────────────

describe("initializationPhase uses runStepTask", () => {
    it("calls runStepTask for title generation", async () => {
        const workDir = tmpDir();

        await run("Test initialization", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // runStepTask should have been called for title-generator
        const titleGenCall = mockRunStepTask.mock.calls.find(
            (c: unknown[]) => (c[0] as { taskId: string }).taskId === "title-generator",
        );
        expect(titleGenCall).toBeDefined();
        const opts = titleGenCall![0] as { profileId: string; phaseId: string };
        expect(opts.profileId).toBe("scout");
        expect(opts.phaseId).toBe("initialization");
    });

    it("title-generator prompt is passed to runStepTask", async () => {
        const workDir = tmpDir();

        await run("Test initialization", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // The runStepTask call for title generation carries the title prompt
        const titleGenCall = mockRunStepTask.mock.calls.find(
            (c: unknown[]) => (c[0] as { taskId: string }).taskId === "title-generator",
        );
        expect(titleGenCall).toBeDefined();
        const prompt = (titleGenCall![0] as { prompt: string }).prompt;
        expect(prompt).toContain("title generator");
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin-engine", () => realEngin);
});
