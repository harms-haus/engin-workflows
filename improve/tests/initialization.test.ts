// ─── Initialization Phase Tests ────────────────────────────────────────────
//
// Tests for the initialization phase added to run():
//   - TitleSchema validation
//   - AI title generation via runStepTask
//   - Sidebar update sequence (Initializing... → AI title)
//   - Resume behavior (skip AI generation)
//   - Fallback on LLM error
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Capture real modules before mocking so we can restore them in afterAll.
const realEngin = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realEngin,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run, TitleSchema } from "../main.ts";
import { WorkflowStatusTracker } from "@harms-haus/engin";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `initialization-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    if (taskId === "title-generator") return { title: "Refactor auth module" };
    if (taskId === "scout-coordinator") return { topics: [] };
    if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
    if (taskId === "planner") return { tasks: [], strategy: "none" };
    if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
    return {};
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);
    mockPromptForStructured.mockReset();
    mockPromptForStructured.mockResolvedValue({ result: {}, attempts: 1 });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TitleSchema", () => {
    it("validates a title string", () => {
        const result = TitleSchema.safeParse({ title: "Refactor auth module" });
        expect(result.success).toBe(true);
    });

    it("rejects missing title field", () => {
        const result = TitleSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it("rejects non-string title", () => {
        const result = TitleSchema.safeParse({ title: 123 });
        expect(result.success).toBe(false);
    });

    it("accepts multi-word titles", () => {
        const result = TitleSchema.safeParse({ title: "Fix performance regression in cache layer" });
        expect(result.success).toBe(true);
    });
});

describe("Initialization Phase Sidebar Updates", () => {
    it("emits 'Initializing...' title before AI generation on fresh start", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Find the call with 'Initializing...'
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const initCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === "Initializing...",
        );
        expect(initCall).toBeDefined();
        expect(initCall!.indicator).toBe("⚙");
    });

    it("emits AI-generated title after initialization completes", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Find the call with the AI-generated title
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        // The title should have been set from the mock response: "Refactor auth module"
        const titleCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === "Refactor auth module",
        );
        expect(titleCall).toBeDefined();
        // It should have an indicator matching the first phase
        expect(typeof titleCall!.indicator).toBe("string");
    });

    it("emits Initializing... before AI title in correct order", async () => {
        const workDir = tmpDir();
        const sidebarTitles: string[] = [];

        const onSidebarUpdate = mock((data: { title?: string; indicator?: string; phases?: unknown[] }) => {
            if (data.title) {
                sidebarTitles.push(data.title);
            }
        });

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // The first title update should be "Initializing..." before the AI title
        const initIndex = sidebarTitles.indexOf("Initializing...");
        const aiTitleIndex = sidebarTitles.indexOf("Refactor auth module");
        expect(initIndex).toBeGreaterThanOrEqual(0);
        expect(aiTitleIndex).toBeGreaterThanOrEqual(0);
        expect(initIndex).toBeLessThan(aiTitleIndex);
    });

    it("initialization runs BEFORE the scouting phase starts", async () => {
        const workDir = tmpDir();

        // Track runStepTask calls to verify title-generator is called first
        mockRunStepTask.mockReset();
        const callOrder: string[] = [];
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            callOrder.push(taskId);
            return smartRunStepTask(opts);
        });

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // title-generator should be called before scout-coordinator
        const titleGenIdx = callOrder.indexOf("title-generator");
        const scoutCoordIdx = callOrder.indexOf("scout-coordinator");
        expect(titleGenIdx).toBeGreaterThanOrEqual(0);
        expect(scoutCoordIdx).toBeGreaterThanOrEqual(0);
        expect(titleGenIdx).toBeLessThan(scoutCoordIdx);
    });
});

describe("Initialization Phase on Resume", () => {
    it("skips AI title generation on resume", async () => {
        const workDir = tmpDir();

        // Pre-create a saved state at "scouting" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setPhase("scouting");
        await tracker.save();

        mockRunStepTask.mockReset();
        const calledTaskIds: string[] = [];
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            calledTaskIds.push(taskId);
            if (taskId === "title-generator") {
                throw new Error("Title generation should NOT be called on resume");
            }
            return smartRunStepTask(opts);
        });

        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Should complete successfully without hitting title generator
        expect(calledTaskIds).not.toContain("title-generator");
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("uses truncated title on resume instead of AI title", async () => {
        const workDir = tmpDir();

        // Pre-create a saved state at "scouting" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("A very long task prompt that exceeds the sixty character limit so it gets truncated with ellipsis at the end");
        tracker.setPhase("scouting");
        await tracker.save();

        const onSidebarUpdate = mock();
        const onWorkflowStart = mock();

        await run("A very long task prompt that exceeds the sixty character limit so it gets truncated with ellipsis at the end", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate, onWorkflowStart },
        });

        // On resume, the sidebar should get the truncated title (not "Initializing...")
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const initCalls = sidebarCalls.filter(
            (c: Record<string, unknown>) => c.title === "Initializing...",
        );
        // No "Initializing..." call on resume
        expect(initCalls).toHaveLength(0);

        // First sidebar call should have the truncated prompt as title
        const firstCall = sidebarCalls[0];
        expect(firstCall.title).toBe("A very long task prompt that exceeds the sixty character ...");
    }, 30000);
});

describe("Initialization Phase Fallback", () => {
    it("falls back to full task prompt when title generation throws", async () => {
        const workDir = tmpDir();

        // Make runStepTask throw for title-generator
        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") {
                throw new Error("LLM unavailable");
            }
            return smartRunStepTask(opts);
        });

        const onSidebarUpdate = mock();

        await run("Refactor the authentication module", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Sidebar should have received the fallback title (the task prompt itself)
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        // Find a call with the fallback - since the prompt is < 60 chars, it should be full
        const fallbackCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === "Refactor the authentication module",
        );
        expect(fallbackCall).toBeDefined();

        // The workflow should still complete successfully
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("falls back to truncated prompt with ellipsis when taskPrompt exceeds 60 chars", async () => {
        const workDir = tmpDir();
        const longPrompt = "This is an extremely long task description that definitely exceeds the sixty character limit for truncation testing";

        // Make runStepTask throw for title-generator
        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") {
                throw new Error("LLM unavailable");
            }
            return smartRunStepTask(opts);
        });

        const onSidebarUpdate = mock();

        await run(longPrompt, {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Sidebar should have received the truncated fallback
        const expectedTruncated = longPrompt.slice(0, 57) + "...";
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const fallbackCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === expectedTruncated,
        );
        expect(fallbackCall).toBeDefined();
    }, 30000);

    it("falls back when runStepTask throws during initialization", async () => {
        const workDir = tmpDir();

        // Make runStepTask throw for title-generator
        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") {
                throw new Error("runStepTask failed");
            }
            return smartRunStepTask(opts);
        });

        const onSidebarUpdate = mock();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Should have used fallback title (full prompt since < 60 chars)
        const sidebarCalls = onSidebarUpdate.mock.calls.map(
            (c: unknown[]) => c[0] as Record<string, unknown>,
        );
        const fallbackCall = sidebarCalls.find(
            (c: Record<string, unknown>) => c.title === "Build a feature",
        );
        expect(fallbackCall).toBeDefined();

        // Workflow should complete
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);
});

describe("Initialization Phase — runStepTask called", () => {
    it("runStepTask called for title-generator on fresh start", async () => {
        const workDir = tmpDir();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // runStepTask should have been called with title-generator taskId
        const titleGenCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "title-generator"
        );
        expect(titleGenCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("title-generator uses TitleSchema for structured output", async () => {
        const workDir = tmpDir();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // First runStepTask call should use TitleSchema
        const firstCall = mockRunStepTask.mock.calls[0];
        expect(firstCall).toBeDefined();
        const opts = firstCall[0] as { schema: { _def: { typeName: string } } };
        expect(opts.schema._def.typeName).toBe("ZodObject");
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
