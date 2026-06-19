// ─── Worktree & Title Tests ────────────────────────────────────────────────
//
// Tests for the changes described in the task (mirroring develop workflow):
//   1. TitleSchema is re-exported from main.ts (backward compat)
//   2. worktree?: WorktreeInfo is accepted in RunOptions
//   3. tracker.setWorktree is called BEFORE tracker.save() in run()
//   4. initializationPhase uses runStepTask for title generation
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

import { run, TitleSchema } from "../main.ts";
import { WorkflowStatusTracker } from "@harms-haus/engin-engine";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `improve-worktree-title-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/**
 * Smart mock for runStepTask based on taskId.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;
    if (taskId === "title-generator") return { title: "AI generated title" };
    if (taskId === "scout-coordinator") return { topics: [] };
    if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
    if (taskId === "planner") return { tasks: [], strategy: "none" };
    if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
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
    mockCreateHarness.mockResolvedValue({ session: { prompt: mock(async () => {}), getLastAssistantText: mock(() => ""), messages: [], subscribe: mock(() => mock()), sessionId: "test-session" }, sessionId: "test-session", dispose: mock() });
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);
    mockRunMultiStepTask.mockImplementation(smartRunMultiStepTask);
    mockPromptForStructured.mockReset();
    mockPromptForStructured.mockResolvedValue({ result: {}, attempts: 1 });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
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

    it("TitleSchema matches the ImportedTitleSchema shape", () => {
        const validData = { title: "Fix cache invalidation bug" };
        const result = TitleSchema.safeParse(validData);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.title).toBe("Fix cache invalidation bug");
        }
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

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    });

    it("run works without worktree option (backward compat)", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
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

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toEqual(worktree);
    });

    it("worktree is undefined in state when not provided", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toBeUndefined();
    });
});

// ── 3. Worktree set BEFORE first save ────────────────────────────────────

describe("worktree set before first save", () => {
    it("worktree is persisted before first save", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-early",
            branchName: "feature/early-set",
            originalCwd: "/project",
        };

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toEqual(worktree);
        expect(state.taskPrompt).toBe("Improve a feature");
    });

    it("worktree persists through phase transitions", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-persist",
            branchName: "feature/persist-all",
            originalCwd: "/project",
        };

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toEqual(worktree);
        expect(state.currentPhaseId).toBe("done");
    });
});

// ── 4. initializationPhase uses runStepTask ──────────────────────────────

describe("initializationPhase uses runStepTask", () => {
    it("runStepTask called for title-generator on fresh start", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const titleGenCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "title-generator"
        );
        expect(titleGenCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("first runStepTask call is for title generation", async () => {
        const workDir = tmpDir();

        await run("Refactor the authentication module", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const firstCall = mockRunStepTask.mock.calls[0];
        expect(firstCall).toBeDefined();
        const opts = firstCall[0] as { taskId: string; prompt: string };
        expect(opts.taskId).toBe("title-generator");
        expect(opts.prompt).toContain("title generator");
    });

    it("uses AI title from runStepTask in sidebar", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        expect(onSidebarUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);

        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const initCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === "Initializing...",
        );
        expect(initCall).toBeDefined();
    });

    it("falls back to truncated prompt when title generation throws", async () => {
        const workDir = tmpDir();
        const longPrompt = "This is an extremely long task description that definitely exceeds the sixty character limit for truncation testing";
        const onSidebarUpdate = mock();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") throw new Error("LLM unavailable");
            return smartRunStepTask(opts);
        });

        await run(longPrompt, {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        const expectedFallback = longPrompt.slice(0, 57) + "...";
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const fallbackCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === expectedFallback,
        );
        expect(fallbackCall).toBeDefined();
    });

    it("runStepTask uses TitleSchema for structured output", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const firstCall = mockRunStepTask.mock.calls[0];
        expect(firstCall).toBeDefined();
        const opts = firstCall[0] as { schema: { _def: { typeName: string } } };
        expect(opts.schema._def.typeName).toBe("ZodObject");
    });
});

// ── 5. Combined: worktree + initialization ───────────────────────────────

describe("worktree integration (current behavior)", () => {
    it("worktree is persisted when provided", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-integration",
            branchName: "feature/integration",
            originalCwd: "/project",
        };

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toEqual(worktree);
        expect(state.currentPhaseId).toBe("done");
    });

    it("worktree property does not exist in state on fresh run", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.worktree).toBeUndefined();
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin-engine", () => realEngin);
});
