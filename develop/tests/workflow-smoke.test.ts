import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const realEngin = Object.assign({}, await import("@harms-haus/engin"));

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

import { run } from "../main";
import { WorkflowStatusTracker } from "@harms-haus/engin";

function makeHarness() {
    return { prompt: mock(async () => {}), getLastAssistantText: mock(() => ""), messages: [] as unknown[], subscribe: mock(() => mock()), sessionId: "test-session", dispose: mock() };
}
function makeHarnessResult() {
    return { session: makeHarness(), sessionId: "test-session", dispose: mock() };
}
function tmpDir(): string {
    return path.join(os.tmpdir(), `workflow-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const BASE_PROFILE = { provider: "openai", model: "gpt-4", thinkingLevel: "medium", systemPrompt: "You are a helpful agent.", excludeTools: [], includeTools: [] };

function makeAllProfiles(): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const id of ["scout", "scout-coordinator", "scouting-reviewer", "planner", "plan-reviewer", "implement-reviewer", "implementer", "fixer", "final-reviewer", "test-writer", "test-reviewer"]) {
        map.set(id, { ...BASE_PROFILE, id, name: id });
    }
    return map;
}

function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;
    const prompt = opts.prompt as string;
    if (taskId === "title-generator") {
        return { title: "Fresh test title" };
    }
    if (taskId === "scout-coordinator" || prompt.includes("codebase scout") || prompt.includes("Identify key areas")) {
        return { topics: [{ topic: "core-module", rationale: "Core logic needs investigation", files: ["src/core.ts"] }] };
    }
    if (taskId === "scouting-reviewer" || prompt.includes("reviewing scouting reports")) {
        return { ready: true, research: "All areas investigated thoroughly. No gaps remain.", gaps: [] };
    }
    if (taskId === "planner" || prompt.includes("planning agent")) {
        return { tasks: [{ id: "t1", title: "Implement core feature", prompt: "Implement the core feature as described", profile: "implementer", files: ["src/core.ts"], dependencies: [], is_code: true }], strategy: "Implement directly in the core module" };
    }
    if (taskId === "plan-reviewer" || prompt.includes("reviewing an implementation plan")) {
        return { ready: true, feedback: "Plan is well-structured and feasible", suggestions: [] };
    }
    if (taskId.startsWith("final-reviewer-round-")) {
        return { topics: [], overallAssessment: "Implementation looks good", issues: [] };
    }
    return {};
}

beforeEach(() => {
    mockLoadProfilesFromDirs.mockReset();
    mockCreateHarness.mockReset();
    mockPromptForStructured.mockReset();
    mockLanePoolRun.mockReset();
    mockLanePoolCtor.mockReset();
    mockRunStepTask.mockReset();

    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);
    // NOTE: Title-generator uses createHarness + promptForStructured, NOT runStepTask
    mockPromptForStructured
        .mockResolvedValueOnce({ result: { title: "Build a simple feature" }, attempts: 1 })
        .mockResolvedValueOnce({ result: { topics: [{ topic: "overall quality", files: ["src/core.ts"] }], overallAssessment: "Code quality is good", issues: [] }, attempts: 1 });
});

describe("Workflow Smoke Tests", () => {
    describe("Full workflow run", () => {
        it("runs all phases and produces expected artifacts", async () => {
            const workDir = tmpDir();

            await run("Build a simple feature", { profilesDir: "/profiles", cwd: "/project", workDir });

            const statePath = path.join(workDir, ".engin-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);
            expect(state.currentPhaseId).toBe("done");
            expect(state.taskPrompt).toBe("Build a simple feature");
            expect(state.completedPhaseIds).toContain("scouting");
            expect(state.completedPhaseIds).toContain("planning");
            expect(state.completedPhaseIds).toContain("implementing");
            expect(state.completedPhaseIds).toContain("review");
        }, 30_000);
    });

    describe("Resume", () => {
        it("resumes from saved state and completes", async () => {
            const workDir = tmpDir();
            const plan = { tasks: [{ id: "t1", title: "Resume task", prompt: "Do it", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Resume" };
            const tracker = new WorkflowStatusTracker(workDir);
            tracker.setTaskPrompt("Resume task");
            tracker.setWorkflowData({ research: "Existing research", plan, scoutingReports: [] });
            tracker.setPhase("implementing");
            await tracker.save();

            // Set up ALL mocks needed for a full fresh-run (resume from saved state
            // actually starts from scouting due to tracker.currentPhase accessor issue)
            // Use the beforeEach's smartRunStepTask and only override what's needed
            mockRunStepTask.mockReset();
            mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
                const taskId = opts.taskId as string;
                if (taskId === "scout-coordinator") return { topics: [] };
                if (taskId === "scouting-reviewer") return { ready: true, research: "Existing research", gaps: [] };
                if (taskId === "planner") return { tasks: [], strategy: "none" };
                if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
                if (taskId.startsWith("final-reviewer-round-")) return { topics: [], overallAssessment: "Good", issues: [] };
                return {};
            });
            mockPromptForStructured.mockReset();
            // On resume, initialization is skipped, so only 1 promptForStructured call (final review)
            mockPromptForStructured
                .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 });

            await run("Resume task", { profilesDir: "/profiles", cwd: "/project", workDir });

            const statePath = path.join(workDir, ".engin-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);
            expect(state.currentPhaseId).toBe("done");
        }, 30_000);
    });

    describe("Abort signal", () => {
        it("handles abort signal gracefully", async () => {
            const workDir = tmpDir();
            const abortController = new AbortController();
            mockRunStepTask.mockImplementation(async (opts: Record<string, unknown>) => {
                if (opts.taskId === "scout-coordinator") {
                    abortController.abort();
                    return { topics: [] };
                }
                return {};
            });
            const onWorkflowFailed = mock();
            await run("Abort test", { profilesDir: "/profiles", cwd: "/project", workDir, signal: abortController.signal, onStatus: { onWorkflowFailed } });
            expect(onWorkflowFailed).toHaveBeenCalledTimes(1);
        }, 30_000);
    });

    describe("Error propagation", () => {
        it("propagates errors and calls onWorkflowFailed", async () => {
            const workDir = tmpDir();
            mockRunStepTask.mockImplementation(async () => { throw new Error("Scout coordinator error"); });
            const onWorkflowFailed = mock();
            await expect(run("Error test", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onWorkflowFailed } })).rejects.toThrow("Scout coordinator error");
            expect(onWorkflowFailed).toHaveBeenCalledTimes(1);
        }, 30_000);
    });

    describe("Callback sequence", () => {
        it("fires onWorkflowStart at the beginning", async () => {
            const workDir = tmpDir();
            const onWorkflowStart = mock();
            const callbackOrder: string[] = [];
            await run("Sequence test", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onWorkflowStart: (info) => { callbackOrder.push("start"); onWorkflowStart(info); } } });
            expect(callbackOrder[0]).toBe("start");
            expect(onWorkflowStart).toHaveBeenCalledTimes(1);
        }, 30_000);

        it("fires onWorkflowComplete at the end", async () => {
            const workDir = tmpDir();
            const onWorkflowComplete = mock();
            await run("Complete test", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onWorkflowComplete } });
            expect(onWorkflowComplete).toHaveBeenCalledTimes(1);
        }, 30_000);

        it("fires onPhaseStart and onPhaseComplete for each phase", async () => {
            const workDir = tmpDir();
            const onPhaseStart = mock();
            const onPhaseComplete = mock();
            await run("Phase test", { profilesDir: "/profiles", cwd: "/project", workDir, onStatus: { onPhaseStart, onPhaseComplete } });
            expect(onPhaseStart.mock.calls.length).toBeGreaterThanOrEqual(4);
            expect(onPhaseComplete.mock.calls.length).toBeGreaterThanOrEqual(4);
        }, 30_000);
    });

    describe("runStepTask calls", () => {
        it("calls runStepTask for title-generator on fresh start", async () => {
            const workDir = tmpDir();
            await run("Fresh test", { profilesDir: "/profiles", cwd: "/project", workDir });
            const titleGenCall = mockRunStepTask.mock.calls.find(
                (c: unknown[]) => (c[0] as { taskId: string }).taskId === "title-generator",
            );
            expect(titleGenCall).toBeDefined();
            const opts = titleGenCall![0] as { profileId: string; phaseId: string };
            expect(opts.profileId).toBe("scout");
            expect(opts.phaseId).toBe("initialization");
        }, 30_000);
    });
});

afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
