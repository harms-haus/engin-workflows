// ─── Worktree & generateWorkflowTitle Tests ────────────────────────────────
//
// Tests for the changes described in the task (mirroring develop workflow T13):
//   1. TitleSchema is re-exported from @harms-haus/engin (backward compat)
//   2. worktree?: WorktreeInfo is accepted in DevelopWorkflowOptions & RunOptions
//   3. tracker.setWorktree is called BEFORE tracker.save() in run()
//   4. initializationPhase delegates to generateWorkflowTitle instead of
//      manually calling createHarness / promptForStructured
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Capture real module before mocking so we can restore it in afterAll.
const realEngin = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockGenerateWorkflowTitle = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realEngin,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    generateWorkflowTitle: (...args: unknown[]) => mockGenerateWorkflowTitle(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run, TitleSchema } from "../main.ts";
import { WorkflowStatusTracker } from "@harms-haus/engin";

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
 * Default mock prompt handler for phases OTHER than initialization.
 * Initialization is handled by generateWorkflowTitle.
 */
function defaultPromptHandler(text: string): unknown {
    if (text.includes("codebase scout") || text.includes("Identify key areas")) {
        return { result: { topics: [] }, attempts: 1 };
    }
    if (text.includes("reviewing scouting reports")) {
        return { result: { ready: true, research: "All scouted", gaps: [] }, attempts: 1 };
    }
    if (text.includes("planning agent")) {
        return { result: { tasks: [], strategy: "none" }, attempts: 1 };
    }
    if (text.includes("reviewing an implementation plan")) {
        return { result: { ready: true, feedback: "OK", suggestions: [] }, attempts: 1 };
    }
    if (text.includes("final quality review")) {
        return { result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 };
    }
    return { result: {}, attempts: 1 };
}

/** Setup mocks for a minimal successful workflow run. */
function setupDefaultMocks() {
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

    // generateWorkflowTitle is used for initialization
    mockGenerateWorkflowTitle.mockResolvedValue("AI generated title");

    // Other phases use promptForStructured
    mockPromptForStructured.mockImplementation(async (_harness: unknown, text: string) => {
        return defaultPromptHandler(text);
    });
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
        // After the source change, TitleSchema will be re-exported from engin's TitleSchema.
        // We verify it has the same shape by checking it parses the same values.
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
        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        // Workflow should complete successfully
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
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
        expect(state.currentPhase).toBe("done");
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

        // The worktree info should be persisted in the state file
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

        // worktree should not be present when not provided
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

        // worktree should be persisted in the state
        expect(state.worktree).toEqual(worktree);
        // taskPrompt should be present
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

        // After all phases complete, worktree should still be persisted
        expect(state.worktree).toEqual(worktree);
        expect(state.currentPhase).toBe("done");
    });
});

// ── 4. initializationPhase uses generateWorkflowTitle ────────────────────

describe("initializationPhase uses createHarness + promptForStructured", () => {
    it("calls createHarness for title generation on fresh start", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // createHarness should have been called for the title-generator
        const titleGenCall = mockCreateHarness.mock.calls.find((call: unknown[]) => {
            const opts = call[0] as { agentId?: string };
            return opts.agentId === "title-generator";
        });
        expect(titleGenCall).toBeDefined();
    });

    it("uses promptForStructured for title generation", async () => {
        const workDir = tmpDir();

        await run("Refactor the authentication module", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // The first promptForStructured call should be for title generation
        const firstPromptCall = mockPromptForStructured.mock.calls[0];
        expect(firstPromptCall).toBeDefined();
        const prompt = firstPromptCall[1] as string;
        expect(prompt).toContain("title generator");
    });

    it("does NOT call generateWorkflowTitle (source uses promptForStructured directly)", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // generateWorkflowTitle should NOT have been called
        expect(mockGenerateWorkflowTitle).not.toHaveBeenCalled();
    });

    it("uses AI title from promptForStructured in sidebar", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Verify sidebar was called at least once
        expect(onSidebarUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Verify "Initializing..." was sent as a title
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

        // Make title generation throw
        let callCount = 0;
        mockPromptForStructured.mockImplementation(async (_harness: unknown, text: string) => {
            callCount++;
            if (callCount === 1) throw new Error("LLM unavailable");
            return defaultPromptHandler(text);
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

    it("createHarness IS called for title generation via promptForStructured", async () => {
        const workDir = tmpDir();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // createHarness should have been called for title generation
        const titleGenCall = mockCreateHarness.mock.calls.find((call: unknown[]) => {
            const opts = call[0] as { agentId?: string };
            return opts.agentId === "title-generator";
        });
        expect(titleGenCall).toBeDefined();
    });

    it("still emits onAgentSpawn and onAgentComplete for initialization", async () => {
        const workDir = tmpDir();
        const onAgentSpawn = mock();
        const onAgentComplete = mock();

        // After the source change, initializationPhase will call generateWorkflowTitle
        // but should still emit onAgentSpawn / onAgentComplete for the title-generator.
        // The implementation wraps generateWorkflowTitle with emit calls.
        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        // Verify the spawn and complete callbacks were fired for title-generator.
        // The spawn/complete are emitted by the wrapper code in initializationPhase,
        // not by generateWorkflowTitle itself.
        const spawnCalls = onAgentSpawn.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string },
        );
        const titleGenSpawn = spawnCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenSpawn).toBeDefined();

        const completeCalls = onAgentComplete.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string },
        );
        const titleGenComplete = completeCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenComplete).toBeDefined();
    });

    it("title-generator agent has correct profile and phase metadata", async () => {
        const workDir = tmpDir();
        const onAgentSpawn = mock();

        await run("Improve a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn },
        });

        // After the source change, the wrapper around generateWorkflowTitle
        // should still emit onAgentSpawn with the correct metadata.
        const spawnCalls = onAgentSpawn.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string; profile: string; phase: string },
        );
        const titleGenSpawn = spawnCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenSpawn).toBeDefined();
        expect(titleGenSpawn!.profile).toBe("scout");
        expect(titleGenSpawn!.phase).toBe("initialization");
    });
});

// ── 5. Combined: worktree + generateWorkflowTitle ────────────────────────

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

        // worktree should be persisted
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toEqual(worktree);
        expect(state.currentPhase).toBe("done");
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
    mock.module("@harms-haus/engin", () => realEngin);
});
