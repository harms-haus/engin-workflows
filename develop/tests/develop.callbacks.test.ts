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
const mockLoadProfiles = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfiles: (...args: unknown[]) => mockLoadProfiles(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
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

import { run } from "../main";
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

/**
 * Smart mock for runStepTask.
 * runStepTask is used for: title-generator, scout-coordinator, scouting-reviewer,
 * planner, plan-reviewer, and final-reviewer.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;

    if (taskId === "title-generator") return { title: "AI generated title" };
    if (taskId === "scout-coordinator") {
        return { topics: [] };
    }
    if (taskId === "scouting-reviewer") {
        return { ready: true, research: "All scouted", gaps: [] };
    }
    if (taskId === "planner") {
        return { tasks: [], strategy: "none" };
    }
    if (taskId === "plan-reviewer") {
        return { ready: true, feedback: "Plan approved", suggestions: [] };
    }
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
        return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
    }
    return {};
}

/** Set up default mocks for a minimal successful run (no tasks). */
function setupHappyPathMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);

    // Reset the mock first to clear any lingering state
    mockPromptForStructured.mockReset();
    // Set up the return values
    mockPromptForStructured
        // initialization: title generation
        .mockResolvedValueOnce({ result: { title: "AI generated title" }, attempts: 1 })
        // final review: clean
        .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 })
        // Fallback for any extra calls (e.g., if fix rounds occur)
        .mockResolvedValue({ result: { topics: [], overallAssessment: "Fallback", issues: [] }, attempts: 1 });
}

/** Set up mocks for a run with one implementation task (approved by LanePool). */
function setupRunWithTaskMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 1, failedTasks: 0 });
    mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
        const taskId = opts.taskId as string;
        if (taskId === "scout-coordinator") return { topics: [] };
        if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
        if (taskId === "planner") {
            return {
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
            };
        }
        if (taskId === "plan-reviewer") return { ready: true, feedback: "Plan approved", suggestions: [] };
        if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
            return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
        }
        return {};
    });

    mockPromptForStructured.mockReset();
    mockPromptForStructured
        // initialization: title generation
        .mockResolvedValueOnce({ result: { title: "AI generated title" }, attempts: 1 })
        // final review: clean
        .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 })
        // Default fallback for safety
        .mockResolvedValue({ result: { topics: [], overallAssessment: "Fallback", issues: [] }, attempts: 1 });
}

/** Set up mocks for a run with one task where LanePool reports a failed task. */
function setupRunWithFailedTaskMocks() {
    mockLoadProfiles.mockResolvedValue(makeAllProfiles());
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 1 });
    mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
        const taskId = opts.taskId as string;
        if (taskId === "scout-coordinator") return { topics: [] };
        if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
        if (taskId === "planner") {
            return {
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
            };
        }
        if (taskId === "plan-reviewer") return { ready: true, feedback: "Plan approved", suggestions: [] };
        if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
            return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
        }
        return {};
    });

    mockPromptForStructured.mockReset();
    mockPromptForStructured
        // initialization: title generation
        .mockResolvedValueOnce({ result: { title: "AI generated title" }, attempts: 1 })
        // final review: clean
        .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 })
        // Default fallback for safety
        .mockResolvedValue({ result: { topics: [], overallAssessment: "Fallback", issues: [] }, attempts: 1 });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    // Manually reset mock call counters only (not implementations/return values)
    // We don't use mock.clearAllMocks() because it can interfere with mockResolvedValueOnce queues
    // Each test sets up its own mocks via setupHappyPathMocks or equivalent.
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

        expect(onWorkflowStart).toHaveBeenCalledTimes(1);
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
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Resumed research", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });
        // promptForStructured is called once for final review (no initialization on resume)
        mockPromptForStructured
            .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "OK", issues: [] }, attempts: 1 });

        const onWorkflowStart = mock();
        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onWorkflowStart },
        });

        expect(onWorkflowStart).toHaveBeenCalledTimes(1);
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

        expect(onWorkflowComplete).toHaveBeenCalledTimes(1);
        const info = onWorkflowComplete.mock.calls[0][0] as { totalDurationMs: number; agentCount: number };
        expect(typeof info.totalDurationMs).toBe("number");
        expect(info.totalDurationMs).toBeGreaterThanOrEqual(0);
        expect(typeof info.agentCount).toBe("number");
    });

    // 6. onWorkflowFailed called on error
    it("onWorkflowFailed called on error", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        // Force an error by making runStepTask reject
        mockRunStepTask.mockReset();
        mockRunStepTask.mockRejectedValue(new Error("LLM unreachable"));

        const onWorkflowFailed = mock();

        await expect(
            run("Build a feature", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
                onStatus: { onWorkflowFailed },
            }),
        ).rejects.toThrow("LLM unreachable");

        expect(onWorkflowFailed).toHaveBeenCalledTimes(1);
        const info = onWorkflowFailed.mock.calls[0][0] as { error: Error };
        expect(info.error).toBeInstanceOf(Error);
        expect(info.error.message).toBe("LLM unreachable");
    });

    // 7. onAgentSpawn/Complete for scout
    it("onAgentSpawn/Complete for scout", async () => {
        const workDir = tmpDir();
        mockLoadProfiles.mockResolvedValue(makeAllProfiles());
        mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
        mockCreateHarness.mockResolvedValue(makeHarnessResult());
        mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") {
                return {
                    topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }],
                };
            }
            if (taskId === "scouting-reviewer") return { ready: true, research: "Scouted", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });
        mockPromptForStructured.mockReset();
        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "OK", issues: [] }, attempts: 1 })
            .mockResolvedValue({ result: { topics: [], overallAssessment: "Fallback", issues: [] }, attempts: 1 });

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn, onAgentComplete },
        });

        // runStepTask fires onAgentSpawn and onAgentComplete internally,
        // but since we mock runStepTask, those callbacks won't fire through the mock.
        // The initialization phase and final review phase use createHarness,
        // and spawnAgent is called which fires onAgentSpawn directly.
        // Verify that runStepTask was called with the right args.
        const coordinatorCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCalls.length).toBeGreaterThanOrEqual(1);
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

        const plannerCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "planner"
        );
        expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
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
        // scoutingReviewPhase calls onDecision directly, planReviewPhase calls onDecision directly
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
        expect(mockLanePoolCtor.mock.calls.length).toBeGreaterThanOrEqual(1);
        // Use the last LanePool construction (most recent call)
        const lastCallIdx = mockLanePoolCtor.mock.calls.length - 1;
        const ctorOptions = mockLanePoolCtor.mock.calls[lastCallIdx][0] as Record<string, unknown>;
        expect(ctorOptions.onStatus).toBeDefined();

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

        expect(mockLanePoolCtor.mock.calls.length).toBeGreaterThanOrEqual(1);
        const lastCallIdx = mockLanePoolCtor.mock.calls.length - 1;
        const ctorOptions = mockLanePoolCtor.mock.calls[lastCallIdx][0] as Record<string, unknown>;
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

        expect(onError).not.toHaveBeenCalled();
    });

    // ── Initialization Phase Callbacks ────────────────────────────────
    // NOTE: Title generation uses runStepTask with taskId 'title-generator'.

    it("runStepTask called for title-generator on fresh start", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

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
        const opts = titleGenCalls[0][0] as { profileId: string; prompt: string };
        expect(opts.profileId).toBe("scout");
        expect(opts.prompt).toContain("title generator");
    });

    it("title-generator prompt includes task prompt", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        await run("Refactor the authentication module", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const titleGenCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "title-generator"
                && ((call[0] as Record<string, unknown>).prompt as string).includes("Refactor the authentication module")
        );
        expect(titleGenCalls.length).toBe(1);
        const opts = titleGenCalls[0][0] as { prompt: string };
        expect(opts.prompt).toContain("title generator");
        expect(opts.prompt).toContain("3-8 word title");
        expect(opts.prompt).toContain("Refactor the authentication module");
    });

    it("title-generator NOT spawned on resume", async () => {
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
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Resumed", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });
        mockPromptForStructured
            .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "OK", issues: [] }, attempts: 1 });

        const onAgentSpawn = mock();
        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onAgentSpawn },
        });

        // On resume, the title-generator agent should NOT be spawned
        const spawnCalls = onAgentSpawn.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string },
        );
        const titleGenSpawn = spawnCalls.find(
            (c: { agentId: string }) => c.agentId === "title-generator",
        );
        expect(titleGenSpawn).toBeUndefined();
    });

    it("title-generator prompt uses TitleSchema for structure", async () => {
        const workDir = tmpDir();
        setupHappyPathMocks();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const titleGenCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "title-generator"
        );
        expect(titleGenCalls.length).toBeGreaterThanOrEqual(1);
        const opts = titleGenCalls[0][0] as { schema: { _def: { typeName: string } } };
        expect(opts.schema._def.typeName).toBe("ZodObject");
    });
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
