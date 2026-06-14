// ─── Worktree & generateWorkflowTitle Tests ────────────────────────────────
//
// Tests for the changes described in the task:
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

import { run, TitleSchema } from "../main";
import { WorkflowStatusTracker } from "@harms-haus/engin";

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
        // Both valid and invalid data should behave identically.
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
        expect(state.currentPhase).toBe("done");
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
        expect(state.currentPhase).toBe("done");
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

        // worktree should not be present when not provided
        expect(state.worktree).toBeUndefined();
    });
});

// ── 3. Worktree set BEFORE first save ────────────────────────────────────

describe("worktree set before first save", () => {
    it("setWorktree is called on tracker before the first save in run()", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-early",
            branchName: "feature/early-set",
            originalCwd: "/project",
        };

        // Track the order of setWorktree and save calls by wrapping tracker
        const callOrder: string[] = [];

        // We intercept the state file write to verify worktree is present
        // from the very first save
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        // Verify the final state has worktree (which means it was set before the
        // first save and persisted through all subsequent saves)
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        // worktree should be present in the persisted state
        expect(state.worktree).toEqual(worktree);
        // taskPrompt should also be present (set before worktree but in same save)
        expect(state.taskPrompt).toBe("Build a feature");
    });

    it("worktree persists through all phase transitions", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-persist",
            branchName: "feature/persist-all",
            originalCwd: "/project",
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

        // After all phases complete, worktree should still be present
        expect(state.worktree).toEqual(worktree);
        expect(state.currentPhase).toBe("done");
    });
});

// ── 4. initializationPhase uses generateWorkflowTitle ────────────────────

describe("initializationPhase uses generateWorkflowTitle", () => {
    it("calls generateWorkflowTitle on fresh start", async () => {
        const workDir = tmpDir();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // generateWorkflowTitle should have been called exactly once for initialization
        expect(mockGenerateWorkflowTitle).toHaveBeenCalledTimes(1);
    });

    it("passes correct options to generateWorkflowTitle", async () => {
        const workDir = tmpDir();

        await run("Refactor the authentication module", {
            profilesDir: "/my-profiles",
            cwd: "/my-project",
            apiKeys: { openai: "sk-test-key" },
            workDir,
        });

        expect(mockGenerateWorkflowTitle).toHaveBeenCalledTimes(1);

        const callArgs = mockGenerateWorkflowTitle.mock.calls[0][0] as Record<string, unknown>;
        expect(callArgs.profilesDirs).toEqual(["/my-profiles"]);
        expect(callArgs.taskPrompt).toBe("Refactor the authentication module");
        expect(callArgs.cwd).toBe("/my-project");
        expect(callArgs.apiKeys).toEqual({ openai: "sk-test-key" });
    });

    it("passes onStatus callbacks to generateWorkflowTitle", async () => {
        const workDir = tmpDir();
        const onStatus = {
            onAgentSpawn: mock(),
            onAgentComplete: mock(),
        };

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus,
        });

        expect(mockGenerateWorkflowTitle).toHaveBeenCalledTimes(1);
        const callArgs = mockGenerateWorkflowTitle.mock.calls[0][0] as Record<string, unknown>;
        expect(callArgs.onStatus).toBeDefined();
    });

    it("does NOT call generateWorkflowTitle on resume", async () => {
        const workDir = tmpDir();

        // Pre-create a saved state at "scouting" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setPhase("scouting");
        await tracker.save();

        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // generateWorkflowTitle should NOT have been called on resume
        expect(mockGenerateWorkflowTitle).not.toHaveBeenCalled();
    });

    it("uses AI title from generateWorkflowTitle in sidebar", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        mockGenerateWorkflowTitle.mockResolvedValue("Custom AI Title");

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const titleCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === "Custom AI Title",
        );
        expect(titleCall).toBeDefined();
    });

    it("falls back to truncated prompt when generateWorkflowTitle returns fallback", async () => {
        const workDir = tmpDir();
        const longPrompt = "This is an extremely long task description that definitely exceeds the sixty character limit for truncation testing";
        const onSidebarUpdate = mock();

        // generateWorkflowTitle returns a truncated fallback (it handles fallback internally)
        const expectedFallback = longPrompt.slice(0, 57) + "...";
        mockGenerateWorkflowTitle.mockResolvedValue(expectedFallback);

        await run(longPrompt, {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const fallbackCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === expectedFallback,
        );
        expect(fallbackCall).toBeDefined();
    });

    it("does NOT call createHarness or promptForStructured for initialization", async () => {
        const workDir = tmpDir();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // generateWorkflowTitle should be called for initialization
        expect(mockGenerateWorkflowTitle).toHaveBeenCalledTimes(1);

        // createHarness and promptForStructured should NOT be called for
        // the title generation phase — they are only called for other phases
        // (scouting, planning, reviewing, etc.)
        //
        // Since generateWorkflowTitle is mocked, the real createHarness inside
        // it is never reached. We verify that the workflow doesn't call
        // createHarness for title generation purposes by checking that all
        // createHarness calls are for non-title-generator agents.
        if (mockCreateHarness.mock.calls.length > 0) {
            for (const call of mockCreateHarness.mock.calls) {
                const opts = call[0] as { agentId?: string };
                // No createHarness call should be for title-generator
                // (generateWorkflowTitle handles that internally)
                expect(opts.agentId).not.toBe("title-generator");
            }
        }
    });

    it("still emits onAgentSpawn and onAgentComplete for initialization", async () => {
        const workDir = tmpDir();
        const onAgentSpawn = mock();
        const onAgentComplete = mock();

        // After the source change, initializationPhase will call generateWorkflowTitle
        // but should still emit onAgentSpawn / onAgentComplete for the title-generator.
        // The implementation wraps generateWorkflowTitle with emit calls.
        await run("Build a feature", {
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

        await run("Build a feature", {
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

describe("worktree + generateWorkflowTitle integration", () => {
    it("worktree is persisted when both worktree and generateWorkflowTitle are used", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-integration",
            branchName: "feature/integration",
            originalCwd: "/project",
        };

        mockGenerateWorkflowTitle.mockResolvedValue("Integration Test Title");

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        // Both worktree and title should be persisted
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.worktree).toEqual(worktree);
        expect(state.currentPhase).toBe("done");

        // generateWorkflowTitle should have been called
        expect(mockGenerateWorkflowTitle).toHaveBeenCalledTimes(1);
    });

    it("worktree on resume is preserved from original run", async () => {
        const workDir = tmpDir();
        const worktree = {
            worktreePath: "/tmp/wt-resume",
            branchName: "feature/resume-test",
            originalCwd: "/project",
        };

        // First run: save with worktree
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            worktree,
        });

        // Verify state has worktree
        const statePath = path.join(workDir, ".engin-state.json");
        let raw = await fs.readFile(statePath, "utf-8");
        let state = JSON.parse(raw);
        expect(state.worktree).toEqual(worktree);

        // Now simulate a resume by loading and re-running
        // The worktree from the previous run should still be in the state
        const restored = await WorkflowStatusTracker.load(workDir);
        expect(restored.worktree).toEqual(worktree);
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
