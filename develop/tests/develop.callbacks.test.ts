// ─── Develop Workflow Callback Tests ────────────────────────────────────────
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile } from "@harms-haus/engin";

// Capture real module before mocking so we can restore it in afterAll.
const realModule = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockParallelAgents = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfiles = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    parallelAgents: (...args: unknown[]) => mockParallelAgents(...args),
    loadProfiles: (...args: unknown[]) => mockLoadProfiles(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
    resolveProfilesDirs: mock(),
    getGlobalConfigDir: mock(),
    getLocalConfigDir: mock(),
    resolveWorkflowsDirs: mock(),
    getDefaultWorkDir: mock(),
    ensureDir: mock(),
}))

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run } from "../main.ts";
import { WorkflowStatusTracker } from "@harms-haus/engin";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const BASE_PROFILE: AgentProfile = {
    id: "base",
    name: "Base",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a helpful agent.",
    excludeTools: [],
    includeTools: [],
};

function makeAllProfiles(): Map<string, AgentProfile> {
    const map = new Map<string, AgentProfile>();
    const ids = [
        "scout",
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
        getLastAssistantText: mock(() => "ok"),
        messages: [],
        subscribe: mock(() => mock()),
        sessionId: "test-session",
    };
}

function makeHarnessResult() {
    return { session: makeHarness(), sessionId: "test-session", dispose: mock() };
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `develop-callbacks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

/** Set up default mocks for a minimal successful run (no tasks). */
function setupHappyPathMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

    mockPromptForStructured
        // initialization: title generation
        .mockResolvedValueOnce({ title: "AI generated title" })
        // scouting: topics (empty)
        .mockResolvedValueOnce({ topics: [] })
        // scouting review: ready
        .mockResolvedValueOnce({ ready: true, research: "All scouted", gaps: [] })
        // planning
        .mockResolvedValueOnce({ tasks: [], strategy: "none" })
        // plan review: approved
        .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
        // final review: clean
        .mockResolvedValueOnce({ topics: [], overallAssessment: "Good", issues: [] });

    mockParallelAgents.mockResolvedValue([]);
}

/** Set up mocks for a run with one implementation task (approved by LanePool). */
function setupRunWithTaskMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });

    mockPromptForStructured
        // initialization: title generation
        .mockResolvedValueOnce({ title: "AI generated title" })
        // scouting: topics (empty)
        .mockResolvedValueOnce({ topics: [] })
        // scouting review: ready
        .mockResolvedValueOnce({ ready: true, research: "All scouted", gaps: [] })
        // planning
        .mockResolvedValueOnce({
            tasks: [
                {
                    id: "t1",
                    title: "Implement feature",
                    prompt: "Do it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Direct",
        })
        // plan review: approved
        .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
        // final review: clean
        .mockResolvedValueOnce({ topics: [], overallAssessment: "Good", issues: [] });

    // parallelAgents for scouting (none) and final review fixers (none)
    mockParallelAgents.mockResolvedValue([]);
}

/** Set up mocks for a run with one task where LanePool reports a failed task
 * (simulating rejection behavior inside the pool). */
function setupRunWithFailedTaskMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 1 });

    mockPromptForStructured
        // initialization: title generation
        .mockResolvedValueOnce({ title: "AI generated title" })
        // scouting: topics (empty)
        .mockResolvedValueOnce({ topics: [] })
        // scouting review: ready
        .mockResolvedValueOnce({ ready: true, research: "All scouted", gaps: [] })
        // planning
        .mockResolvedValueOnce({
            tasks: [
                {
                    id: "t1",
                    title: "Bad task",
                    prompt: "Do it badly",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Direct",
        })
        // plan review: approved
        .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
        // final review: clean
        .mockResolvedValueOnce({ topics: [], overallAssessment: "Good", issues: [] });

    mockParallelAgents.mockResolvedValue([]);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Workflow-level callbacks", () => {
    // 1. onWorkflowStart called on fresh start
    it("onWorkflowStart called on fresh start", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onWorkflowStart = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowStart },
        });

        expect(onWorkflowStart).toHaveBeenCalledOnce();
        expect(onWorkflowStart).toHaveBeenCalledWith({
            taskPrompt: "Build a feature",
            resumed: false,
            workDir,
        });
    });

    // 2. onWorkflowStart called with resumed: true
    it("onWorkflowStart called with resumed: true", async () => {
        const workDir = tmpDir();

        // Pre-create a saved state at "planning" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setPhase("planning");
        await tracker.save();

        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
        mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());
        mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

        mockPromptForStructured
            // scoutingReviewPhase (deriving research from empty reports)
            .mockResolvedValueOnce({ ready: true, research: "Resumed research", gaps: [] })
            // planning
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            // plan review: approved
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review: clean
            .mockResolvedValueOnce({ topics: [], overallAssessment: "OK", issues: [] });

        mockParallelAgents.mockResolvedValue([]);

        const onWorkflowStart = mock();
        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowStart },
        });

        expect(onWorkflowStart).toHaveBeenCalledOnce();
        expect(onWorkflowStart).toHaveBeenCalledWith({
            taskPrompt: "Resumed task",
            resumed: true,
            workDir,
        });
    });

    // 3. onPhaseStart called for each phase
    it("onPhaseStart called for each phase", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onPhaseStart = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onPhaseStart },
        });

        expect(onPhaseStart.mock.calls.length).toBeGreaterThanOrEqual(4);

        const phases = onPhaseStart.mock.calls.map((call: unknown[]) => (call[0] as { phase: string }).phase);
        expect(phases).toContain("scouting");
        expect(phases).toContain("planning");
        expect(phases).toContain("implementing");
        expect(phases).toContain("review");
    });

    // 4. onPhaseComplete called for each phase
    it("onPhaseComplete called for each phase", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onPhaseComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onPhaseComplete },
        });

        expect(onPhaseComplete.mock.calls.length).toBeGreaterThanOrEqual(4);

        // Each call should have a phase and durationMs
        for (const call of onPhaseComplete.mock.calls) {
            const info = call[0] as { phase: string; durationMs: number };
            expect(typeof info.phase).toBe("string");
            expect(typeof info.durationMs).toBe("number");
            expect(info.durationMs).toBeGreaterThanOrEqual(0);
        }
    });

    // 5. onWorkflowComplete called at end
    it("onWorkflowComplete called at end", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onWorkflowComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowComplete },
        });

        expect(onWorkflowComplete).toHaveBeenCalledOnce();
        const info = onWorkflowComplete.mock.calls[0][0] as { totalDurationMs: number; agentCount: number };
        expect(typeof info.totalDurationMs).toBe("number");
        expect(info.totalDurationMs).toBeGreaterThanOrEqual(0);
        expect(typeof info.agentCount).toBe("number");
    });

    // 6. onWorkflowFailed called on error
    it("onWorkflowFailed called on error", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        // Override: scouting throws
        mockPromptForStructured.mockReset();
        mockPromptForStructured.mockRejectedValue(new Error("LLM unreachable"));

        const onWorkflowFailed = mock();

        await expect(
            run("Build a feature", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
                onStatus: { onWorkflowFailed },
            }),
        ).rejects.toThrow("LLM unreachable");

        expect(onWorkflowFailed).toHaveBeenCalledOnce();
        const info = onWorkflowFailed.mock.calls[0][0] as { error: Error; phase: string };
        expect(info.error).toBeInstanceOf(Error);
        expect(info.error.message).toBe("LLM unreachable");
        expect(typeof info.phase).toBe("string");
    });

    // 7. onAgentSpawn/Complete for scout
    it("onAgentSpawn/Complete for scout", async () => {
        const workDir = tmpDir();
        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
        mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());
        mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI generated title" })
            // scouting: topics (with one topic)
            .mockResolvedValueOnce({
                topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }],
            })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Scouted", gaps: [] })
            // planning
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            // plan review: approved
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review: clean
            .mockResolvedValueOnce({ topics: [], overallAssessment: "OK", issues: [] });

        // parallelAgents for the scout
        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: { report: "scout report" } },
        ]);

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        // Scout coordinator spawns and completes
        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const completeCalls = onAgentComplete.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });

        // Match scout agents by profile='scout' (not agentId, since 'scouting-reviewer' also contains 'scout')
        // Exclude the title-generator which also uses the scout profile but has its own agentId
        const scoutSpawns = spawnCalls.filter((c) => c.profile === "scout" && c.agentId !== "title-generator");
        const scoutCompletes = completeCalls.filter((c) => c.profile === "scout" && c.agentId !== "title-generator");

        expect(scoutSpawns.length).toBeGreaterThanOrEqual(1);
        expect(scoutCompletes.length).toBeGreaterThanOrEqual(1);

        // Verify agentId contains 'scout' for all matched entries
        for (const spawn of scoutSpawns) {
            expect(spawn.agentId).toContain("scout");
        }
    });

    // 8. onAgentSpawn/Complete for planner
    it("onAgentSpawn/Complete for planner", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const completeCalls = onAgentComplete.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });

        const plannerSpawns = spawnCalls.filter((c) => c.agentId.includes("planner"));
        const plannerCompletes = completeCalls.filter((c) => c.agentId.includes("planner"));

        expect(plannerSpawns.length).toBeGreaterThanOrEqual(1);
        expect(plannerCompletes.length).toBeGreaterThanOrEqual(1);

        for (const spawn of plannerSpawns) {
            expect(spawn.profile).toBe("planner");
        }
    });

    // 9. onDecision called for reviews
    it("onDecision called for reviews", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onDecision = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onDecision },
        });

        // At least 2 decisions: scouting review + plan review
        expect(onDecision.mock.calls.length).toBeGreaterThanOrEqual(2);

        const decisions = onDecision.mock.calls.map((c: unknown[]) => c[0] as { decision: string; reasoning: string });
        const decisionTypes = decisions.map((d) => d.decision);
        expect(decisionTypes).toContain("proceed_to_planning");
        expect(decisionTypes).toContain("plan_approved");

        // All decisions should have reasoning
        for (const d of decisions) {
            expect(typeof d.reasoning).toBe("string");
            expect(d.reasoning.length).toBeGreaterThan(0);
        }
    });

    // 10. LanePool receives onStatus callbacks for tasks
    it("LanePool receives onStatus callbacks for tasks", async () => {
        const workDir = tmpDir();
        setupRunWithTaskMocks();

        const onTaskStart = mock();
        const onTaskComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onTaskStart, onTaskComplete },
        });

        // LanePool should have been constructed with onStatus callbacks
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.onStatus).toBeDefined();

        // Note: onTaskStart/onTaskComplete are called by LanePool internally,
        // not by the workflow orchestrator. Since we mock LanePool, these
        // callbacks won't fire through the mock. Instead, verify that the
        // onStatus object passed to LanePool contains the expected callbacks.
        const passedStatus = ctorOptions.onStatus as Record<string, unknown>;
        expect(typeof passedStatus.onTaskStart).toBe("function");
        expect(typeof passedStatus.onTaskComplete).toBe("function");
    });

    // 11. LanePool receives onTaskRejected callback
    it("LanePool receives onTaskRejected callback", async () => {
        const workDir = tmpDir();
        setupRunWithFailedTaskMocks();

        const onTaskRejected = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onTaskRejected },
        });

        // LanePool should have been constructed with onStatus containing onTaskRejected
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const passedStatus = ctorOptions.onStatus as Record<string, unknown>;
        expect(typeof passedStatus.onTaskRejected).toBe("function");
    });

    // 12. onError callback NOT called by orchestrator when LanePool handles failures
    it("onError not called by orchestrator for LanePool-internal failures", async () => {
        const workDir = tmpDir();
        setupRunWithFailedTaskMocks();

        const onError = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onError },
        });

        // The orchestrator does not call onError for task failures inside LanePool.
        // LanePool handles failures internally via onTaskRejected.
        expect(onError).not.toHaveBeenCalled();
    });

    // ── Initialization Phase Callbacks ────────────────────────────────

    it("onAgentSpawn called for title-generator on fresh start", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        // On fresh start, initialization phase spawns a title-generator agent
        const spawnCalls = onAgentSpawn.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string },
        );
        const titleGenSpawn = spawnCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenSpawn).toBeDefined();
        expect(titleGenSpawn!.agentId).toBe("title-generator");
    });

    it("onAgentComplete called for title-generator on fresh start", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        const completeCalls = onAgentComplete.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string },
        );
        const titleGenComplete = completeCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenComplete).toBeDefined();
        expect(titleGenComplete!.agentId).toBe("title-generator");
    });

    it("title-generator agent has profile 'scout' and phase 'initialization'", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onAgentSpawn = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn },
        });

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

    it("title-generator onAgentComplete has profile and phase", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentComplete },
        });

        const completeCalls = onAgentComplete.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string; profile: string; phase: string },
        );
        const titleGenComplete = completeCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenComplete).toBeDefined();
        expect(titleGenComplete!.profile).toBe("scout");
        expect(titleGenComplete!.phase).toBe("initialization");
    });

    it("title-generator uses scout profile harness via createHarness", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        const onStatus = {};
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus,
        });

        // createHarness should have been called with scout profile for title generation
        // It's the first call to createHarness (before the scouting coordinator)
        const firstHarnessCall = mockCreateHarness.mock.calls[0];
        expect(firstHarnessCall).toBeDefined();
        const opts = firstHarnessCall[0] as { profile: { id: string } };
        expect(opts.profile.id).toBe("scout");
    });

    it("title-generator prompt contains task description", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

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
        expect(prompt).toContain("3-8 word title");
        expect(prompt).toContain("Refactor the authentication module");
    });

    it("title-generator uses TitleSchema for structured output", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // The first promptForStructured call should use TitleSchema
        const firstPromptCall = mockPromptForStructured.mock.calls[0];
        expect(firstPromptCall).toBeDefined();
        // Third argument should be the schema
        const schema = firstPromptCall[2] as { _def: { typeName: string } };
        // Zod object schema has typeName "ZodObject"
        expect(schema._def.typeName).toBe("ZodObject");
    });

    it("title-generator is NOT spawned on resume", async () => {
        const workDir = tmpDir();

        // Pre-create a saved state at "scouting" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setPhase("scouting");
        await tracker.save();

        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
        mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());
        mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });

        mockPromptForStructured
            // scouting topics
            .mockResolvedValueOnce({ topics: [] })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Resumed", gaps: [] })
            // planning
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            // plan review: approved
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review: clean
            .mockResolvedValueOnce({ topics: [], overallAssessment: "OK", issues: [] });

        mockParallelAgents.mockResolvedValue([]);

        const onAgentSpawn = mock();
        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn },
        });

        // No title-generator spawn on resume
        const spawnCalls = onAgentSpawn.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string },
        );
        const titleGenSpawn = spawnCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenSpawn).toBeUndefined();
    });
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
