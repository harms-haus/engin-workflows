// ─── Initialization Phase Tests ────────────────────────────────────────────
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

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

import { run, TitleSchema } from "../main";
import { WorkflowStatusTracker } from "@harms-haus/engin";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tmpDir(): string {
    return path.join(os.tmpdir(), `initialization-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const BASE_PROFILE = { provider: "openai", model: "gpt-4", thinkingLevel: "medium", systemPrompt: "You are a helpful agent.", excludeTools: [], includeTools: [] };

function makeAllProfiles(): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const id of ["scout", "scout-coordinator", "scouting-reviewer", "planner", "plan-reviewer", "implement-reviewer", "implementer", "fixer", "final-reviewer", "test-writer", "test-reviewer"]) {
        map.set(id, { ...BASE_PROFILE, id, name: id });
    }
    return map;
}

function makeHarness() {
    return { prompt: mock(async () => {}), getLastAssistantText: mock(() => ""), messages: [] as unknown[], subscribe: mock(() => mock()), sessionId: "test-session", dispose: mock() };
}

function makeHarnessResult() {
    return { session: makeHarness(), sessionId: "test-session", dispose: mock() };
}

/** Setup standard mocks for initialization tests. */
function setupStandardMocks() {
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
        const taskId = opts.taskId as string;
        if (taskId === "title-generator") return { title: "Refactor auth module" };
        if (taskId === "scout-coordinator") return { topics: [] };
        if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
        if (taskId === "planner") return { tasks: [], strategy: "none" };
        if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
        if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
            return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
        }
        return {};
    });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    setupStandardMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TitleSchema", () => {
    it("validates a title string", () => {
        expect(TitleSchema.safeParse({ title: "Refactor auth module" }).success).toBe(true);
    });
    it("rejects missing title field", () => {
        expect(TitleSchema.safeParse({}).success).toBe(false);
    });
    it("rejects non-string title", () => {
        expect(TitleSchema.safeParse({ title: 123 }).success).toBe(false);
    });
    it("accepts multi-word titles", () => {
        expect(TitleSchema.safeParse({ title: "Fix performance regression in cache layer" }).success).toBe(true);
    });
});

describe("Initialization Phase Sidebar Updates", () => {
    it("emits 'Initializing...' title before AI generation on fresh start", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onSidebarUpdate } });

        const sidebarCalls = onSidebarUpdate.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
        const initCall = sidebarCalls.find((c: Record<string, unknown>) => c.title === "Initializing...");
        expect(initCall).toBeDefined();
        expect(initCall!.indicator).toBe("⚙");
    });

    it("emits AI-generated title after initialization completes", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onSidebarUpdate } });

        const sidebarCalls = onSidebarUpdate.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
        const titleCall = sidebarCalls.find((c: Record<string, unknown>) => c.title === "Refactor auth module");
        expect(titleCall).toBeDefined();
        expect(typeof titleCall!.indicator).toBe("string");
    });

    it("emits Initializing... before AI title in correct order", async () => {
        const workDir = tmpDir();
        const sidebarTitles: string[] = [];
        const onSidebarUpdate = mock((data: { title?: string }) => { if (data.title) sidebarTitles.push(data.title); });

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onSidebarUpdate } });

        const initIndex = sidebarTitles.indexOf("Initializing...");
        const aiTitleIndex = sidebarTitles.indexOf("Refactor auth module");
        expect(initIndex).toBeGreaterThanOrEqual(0);
        expect(aiTitleIndex).toBeGreaterThanOrEqual(0);
        expect(initIndex).toBeLessThan(aiTitleIndex);
    });

    it("initialization runs BEFORE the scouting phase starts", async () => {
        const workDir = tmpDir();

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir });

        // title-generator (initialization) must be invoked before scout-coordinator (scouting)
        const callTaskIds = mockRunStepTask.mock.calls.map((c: unknown[]) => (c[0] as { taskId: string }).taskId);
        const titleIdx = callTaskIds.indexOf("title-generator");
        const scoutIdx = callTaskIds.indexOf("scout-coordinator");
        expect(titleIdx).toBeGreaterThanOrEqual(0);
        expect(scoutIdx).toBeGreaterThanOrEqual(0);
        expect(titleIdx).toBeLessThan(scoutIdx);
    });
});

describe("Initialization Phase - runStepTask", () => {
    it("uses runStepTask for title generation with scout profile", async () => {
        const workDir = tmpDir();

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir });

        const titleGenCall = mockRunStepTask.mock.calls.find(
            (c: unknown[]) => (c[0] as { taskId: string }).taskId === "title-generator",
        );
        expect(titleGenCall).toBeDefined();
        const opts = titleGenCall![0] as { profileId: string; phaseId: string; stepName: string; isReadOnly: boolean };
        expect(opts.profileId).toBe("scout");
        expect(opts.phaseId).toBe("initialization");
        expect(opts.stepName).toBe("generate-title");
        expect(opts.isReadOnly).toBe(true);
    });

    it("title-generator prompt contains task description", async () => {
        const workDir = tmpDir();

        await run("Refactor the authentication module", { profilesDir: "/profiles", cwd: "/project", workDir });

        const titleGenCall = mockRunStepTask.mock.calls.find(
            (c: unknown[]) => (c[0] as { taskId: string }).taskId === "title-generator",
        );
        expect(titleGenCall).toBeDefined();
        const prompt = (titleGenCall![0] as { prompt: string }).prompt;
        expect(prompt).toContain("title generator");
        expect(prompt).toContain("3-8 word title");
        expect(prompt).toContain("Refactor the authentication module");
    });

    it("title-generator uses TitleSchema for structured output", async () => {
        const workDir = tmpDir();

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir });

        const titleGenCall = mockRunStepTask.mock.calls.find(
            (c: unknown[]) => (c[0] as { taskId: string }).taskId === "title-generator",
        );
        expect(titleGenCall).toBeDefined();
        const schema = (titleGenCall![0] as { schema: { _def: { typeName: string } } }).schema;
        expect(schema._def.typeName).toBe("ZodObject");
    });

    it("title-generator is NOT used on resume", async () => {
        const workDir = tmpDir();

        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setPhase("scouting");
        await tracker.save();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Resumed", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });
        mockPromptForStructured.mockReset();
        mockPromptForStructured.mockResolvedValueOnce({ result: { topics: [], overallAssessment: "OK", issues: [] }, attempts: 1 });

        const onAgentSpawn = mock();
        await run("Resumed task", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onAgentSpawn } });

        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string });
        const titleGenSpawn = spawnCalls.find((c: { agentId: string }) => c.agentId === "title-generator");
        expect(titleGenSpawn).toBeUndefined();
    });
});

afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
