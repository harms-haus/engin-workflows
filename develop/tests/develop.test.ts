// ─── Develop Workflow Tests ──────────────────────────────────────────────────
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile } from "@harms-haus/engin-engine";
import type { Plan, ScoutingReview, PlanReview, ReviewResult, FinalReviewTopics } from "../main";

// Capture real module before mocking so we can restore it in afterAll.
const realModule = Object.assign({}, await import("@harms-haus/engin-engine"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunMultiStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin-engine", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
    runMultiStepTask: (...args: unknown[]) => mockRunMultiStepTask(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}))

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
    createHarness,
    promptForStructured,
    loadProfilesFromDirs,
    WorkflowStatusTracker,
} from "@harms-haus/engin-engine";
import {
    scoutingPhase,
    scoutingReviewPhase,
    planningPhase,
    implementationPhase,
    finalReviewPhase,
    run,
    ScoutingTopicSchema,
    ScoutingReviewSchema,
    PlanSchema,
    PlanReviewSchema,
    ReviewResultSchema,
    FinalReviewTopicsSchema,
    FinalReviewResultSchema,
    TitleSchema,
    workflowConfig,
} from "../main";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const SCOUT_PROFILE: AgentProfile = {
    id: "scout",
    name: "Scout",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a scout agent.",
    excludeTools: [],
    includeTools: [],
};

const REVIEWER_PROFILE: AgentProfile = {
    id: "implement-reviewer",
    name: "Reviewer",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a reviewer agent.",
    excludeTools: [],
    includeTools: [],
};

const IMPLEMENTER_PROFILE: AgentProfile = {
    id: "implementer",
    name: "Implementer",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are an implementer agent.",
    excludeTools: [],
    includeTools: [],
};

const FIXER_PROFILE: AgentProfile = {
    id: "fixer",
    name: "Fixer",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a fix agent.",
    excludeTools: [],
    includeTools: [],
};

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

function makeAllProfiles(): Map<string, AgentProfile> {
    const map = new Map<string, AgentProfile>();
    map.set("scout", SCOUT_PROFILE);
    map.set("scout-coordinator", { ...SCOUT_PROFILE, id: "scout-coordinator", name: "Scout Coordinator" });
    map.set("scouting-reviewer", { ...SCOUT_PROFILE, id: "scouting-reviewer", name: "Scouting Reviewer" });
    map.set("planner", { ...SCOUT_PROFILE, id: "planner", name: "Planner" });
    map.set("plan-reviewer", { ...SCOUT_PROFILE, id: "plan-reviewer", name: "Plan Reviewer" });
    map.set("implement-reviewer", REVIEWER_PROFILE);
    map.set("implementer", IMPLEMENTER_PROFILE);
    map.set("fixer", FIXER_PROFILE);
    map.set("final-reviewer", { ...SCOUT_PROFILE, id: "final-reviewer", name: "Final Reviewer" });
    map.set("test-writer", { ...SCOUT_PROFILE, id: "test-writer", name: "Test Writer" });
    map.set("test-reviewer", { ...SCOUT_PROFILE, id: "test-reviewer", name: "Test Reviewer" });
    return map;
}

function tmpDir(): string {
    return path.join(os.tmpdir(), `develop-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Default plan written by the smart runMultiStepTask mock when no plan.json exists. */
const DEFAULT_PLAN: Plan = {
    tasks: [{ id: "t1", title: "Default task", prompt: "Do it", profile: "implementer", files: ["src/index.ts"], dependencies: [], is_code: true }],
    strategy: "Default strategy",
};

/**
 * Smart mock for runStepTask based on taskId.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;
    if (taskId === "title-generator") return { title: "AI generated title" };
    if (taskId === "scout-coordinator") {
        return {
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
                { topic: "module-b", rationale: "Supporting module", files: ["src/b.ts"] },
            ],
        };
    }
    if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
    if (taskId === "planner") return { tasks: [], strategy: "none" };
    if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
        return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
    }
    return {};
}

/** Reset promptForStructured and set up standard 2-call pattern (init + final review). */
function setupPromptMocks(): void {
    mockPromptForStructured.mockReset();
    mockPromptForStructured
        .mockResolvedValueOnce({ result: { title: "AI generated title" }, attempts: 1 })
        .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 })
        .mockResolvedValue({ result: { topics: [], overallAssessment: "Fallback", issues: [] }, attempts: 1 });
}

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
            // The real planner writes plan.json; ensure one exists so the
            // validateOutput gate succeeds. Derive the path from the plan step's
            // write sandbox (allowedWriteDirs[0]/plan.json).
            const allowed = (step.allowedWriteDirs as string[] | undefined)?.[0];
            if (allowed) {
                const planPath = path.join(allowed, "plan.json");
                try {
                    await fs.access(planPath);
                } catch {
                    await fs.mkdir(allowed, { recursive: true });
                    await fs.writeFile(planPath, JSON.stringify(DEFAULT_PLAN, null, 2));
                }
            }
            await step.validateOutput();
        }
        results.push(step.stepName === "review-plan" ? { ready: true, feedback: "OK", suggestions: [] } : undefined);
    }
    return { results, approved: true };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    // Reset mock call history and implementations
    mockCreateHarness.mockReset();
    mockPromptForStructured.mockReset();
    mockLoadProfilesFromDirs.mockReset();
    mockLanePoolRun.mockReset();
    mockLanePoolCtor.mockReset();
    mockRunStepTask.mockReset();
    mockRunMultiStepTask.mockReset();

    // Set up default implementations
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    
    // Dynamic LanePool that auto-completes tasks
    mockLanePoolRun.mockImplementation(async function() {
        // Simply return success - don't try to manipulate internal task tracker state
        return { completedTasks: 0, failedTasks: 0 };
    });
    
    mockRunStepTask.mockImplementation(smartRunStepTask);
    mockRunMultiStepTask.mockImplementation(smartRunMultiStepTask);
    
    // Set up prompt mocks (2 calls: init + final review)
    setupPromptMocks();
});

// ─── Schemas ────────────────────────────────────────────────────────────────

describe("Zod Schemas", () => {
    it("ScoutingTopicSchema validates correct structure", () => {
        const data = {
            topics: [{ topic: "auth module", rationale: "Need to understand login flow", files: ["src/auth.ts"] }],
        };
        expect(ScoutingTopicSchema.safeParse(data).success).toBe(true);
    });

    it("ScoutingReviewSchema validates correct structure", () => {
        const data = { ready: true, research: "Found everything we need", gaps: [] };
        expect(ScoutingReviewSchema.safeParse(data).success).toBe(true);
    });

    it("PlanSchema validates correct structure", () => {
        const data = {
            tasks: [{
                id: "t1", title: "Add login", prompt: "Implement login",
                profile: "implementer", files: ["src/auth.ts"], dependencies: [], is_code: true,
            }],
            strategy: "Bottom-up approach",
        };
        expect(PlanSchema.safeParse(data).success).toBe(true);
    });

    it("PlanReviewSchema validates correct structure", () => {
        const data = { ready: true, feedback: "Plan looks good", suggestions: [] };
        expect(PlanReviewSchema.safeParse(data).success).toBe(true);
    });

    it("ReviewResultSchema validates correct structure", () => {
        const data = { approved: true, feedback: "Looks correct", issues: [] };
        expect(ReviewResultSchema.safeParse(data).success).toBe(true);
    });

    it("FinalReviewTopicsSchema validates correct structure", () => {
        const data = {
            topics: [{ topic: "error handling", files: ["src/errors.ts"] }],
            overallAssessment: "Good quality",
            issues: [{ file: "src/errors.ts", description: "Missing null check", severity: "critical" as const }],
        };
        expect(FinalReviewTopicsSchema.safeParse(data).success).toBe(true);
    });

    it("FinalReviewResultSchema is exported and parseable", () => {
        expect(typeof FinalReviewResultSchema.parse).toBe("function");
        const clean = { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
        expect(FinalReviewResultSchema.safeParse(clean).success).toBe(true);
    });

    it("TitleSchema validates a concise title string", () => {
        expect(TitleSchema.safeParse({ title: "Refactor auth module" }).success).toBe(true);
    });

    it("TitleSchema rejects missing title", () => {
        expect(TitleSchema.safeParse({}).success).toBe(false);
    });

    it("TitleSchema rejects non-string title", () => {
        expect(TitleSchema.safeParse({ title: 42 }).success).toBe(false);
    });

    it("TitleSchema accepts title up to any length", () => {
        expect(TitleSchema.safeParse({ title: "A very long title that exceeds eight words easily" }).success).toBe(true);
    });
});

// ─── workflowConfig ─────────────────────────────────────────────────────────

describe("workflowConfig", () => {
    it("finalReviewers lists the five specialized reviewers in order", () => {
        expect(Array.isArray(workflowConfig.finalReviewers)).toBe(true);
        expect(workflowConfig.finalReviewers).toHaveLength(5);
        expect(workflowConfig.finalReviewers!.map((r) => r.profileId)).toEqual([
            "efficiency-reviewer",
            "code-quality-reviewer",
            "ui-ux-reviewer",
            "security-reviewer",
            "documentation-reviewer",
        ]);
    });
});

// ─── scoutingPhase ──────────────────────────────────────────────────────────

describe("scoutingPhase", () => {
    it("calls runStepTask for coordinator, creates LanePool for scouts", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        expect(mockRunStepTask).toHaveBeenCalledTimes(1);
        const coordinatorCall = mockRunStepTask.mock.calls[0][0] as Record<string, unknown>;
        expect(coordinatorCall.taskId).toBe("scout-coordinator");
        expect(coordinatorCall.profileId).toBe("scout-coordinator");

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
        expect(mockLanePoolCtor).toHaveBeenCalledWith(
            expect.objectContaining({ maxConcurrentLanes: 3, profilesDirs: ["/profiles"], cwd: "/cwd" }),
        );
    });

    it("returns reports from completed scout tasks", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Make LanePool run actually process tasks
        mockLanePoolRun.mockImplementation(async function() {
            const lastCall = mockLanePoolCtor.mock.calls[mockLanePoolCtor.mock.calls.length - 1];
            if (lastCall?.[0]) {
                const opts = lastCall[0] as Record<string, unknown>;
                if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                    const tt = opts.taskTracker as any;
                    for (const task of [...tt.getAllTasks()]) {
                        task.status = 'complete';
                        task.result = { report: `scout report for ${task.title}` };
                    }
                }
            }
            return { completedTasks: 2, failedTasks: 0 };
        });

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);
        expect(reports).toHaveLength(2);
    });

    it("returns empty reports when no topics found", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockResolvedValueOnce({ topics: [] });

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);
        expect(reports).toEqual([]);
        expect(mockLanePoolCtor).not.toHaveBeenCalled();
    });

    it("handles partial failures in LanePool", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLanePoolRun.mockImplementation(async function() {
            const lastCall = mockLanePoolCtor.mock.calls[mockLanePoolCtor.mock.calls.length - 1];
            if (lastCall?.[0]) {
                const opts = lastCall[0] as Record<string, unknown>;
                if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                    const tt = opts.taskTracker as any;
                    const allTasks = [...tt.getAllTasks()];
                    // Only set first task to complete, leave second as ready (failed)
                    if (allTasks.length > 0) {
                        allTasks[0].status = 'complete';
                        allTasks[0].result = { report: 'success' };
                    }
                }
            }
            return { completedTasks: 1, failedTasks: 1 };
        });

        const reports = await scoutingPhase(tracker, ["/profiles"], "task", "/cwd", 3, workDir);
        expect(reports).toHaveLength(1);
    });

    it("throws if scout-coordinator profile not found via runStepTask", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockRejectedValue(new Error('Profile "scout-coordinator" not found'));

        await expect(
            scoutingPhase(tracker, ["/profiles"], "task", "/cwd", 3, workDir),
        ).rejects.toThrow('not found');
    });
});

// ─── scoutingReviewPhase ────────────────────────────────────────────────────

describe("scoutingReviewPhase", () => {
    it("returns ready=true with research summary", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const reviewResult: ScoutingReview = { ready: true, research: "All areas investigated thoroughly", files: [], gaps: [] };
        mockRunStepTask.mockReset();
        mockRunStepTask.mockResolvedValueOnce(reviewResult);

        const result = await scoutingReviewPhase(tracker, ["/profiles"], "Implement feature X", [{ summary: "report 1" }], "/cwd");
        expect(result).toEqual(reviewResult);
        expect(mockRunStepTask).toHaveBeenCalledTimes(1);
    });

    it("returns ready=false with gaps when more scouting needed", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockResolvedValueOnce({
            ready: false, research: "Partial findings",
            gaps: [{ topic: "Need to investigate test coverage", rationale: "Coverage gaps identified", files: ["tests/"] }],
        });

        const result = await scoutingReviewPhase(tracker, ["/profiles"], "Implement feature X", [], "/cwd");
        expect(result.ready).toBe(false);
        expect(result.gaps).toHaveLength(1);
    });
});

// ─── planningPhase ──────────────────────────────────────────────────────────

describe("planningPhase", () => {
    it("creates a plan with tasks", async () => {
        const workDir = tmpDir();
        const artifactsDir = path.join(workDir, "artifacts");
        await fs.mkdir(artifactsDir, { recursive: true });
        const tracker = new WorkflowStatusTracker(workDir);

        const plan: Plan = {
            tasks: [
                { id: "t1", title: "Implement feature X", prompt: "Create the X module", profile: "implementer", files: ["src/x.ts"], dependencies: [], is_code: true },
                { id: "t2", title: "Add tests for X", prompt: "Write tests", profile: "implementer", files: ["tests/x.test.ts"], dependencies: ["t1"], is_code: true },
            ],
            strategy: "Implement core first, then tests",
        };
        // The planner writes plan.json; the smart runMultiStepTask mock invokes
        // the validateOutput gate, which reads this back into planningPhase.
        await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));

        const result = await planningPhase(tracker, ["/profiles"], "Research summary", [], "Build feature X", "/cwd", workDir);
        expect(result).toEqual(plan);
        expect(result.tasks).toHaveLength(2);
        expect((tracker.workflowData as { plan: unknown }).plan).toEqual(plan);
    });
});

// ─── implementationPhase ────────────────────────────────────────────────────

describe("implementationPhase", () => {
    it("creates LanePool with correct maxConcurrentLanes", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Task 1", prompt: "Do task 1", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Sequential" };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.maxConcurrentLanes).toBe(3);
        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
    });

    it("passes profilesDirs to LanePool", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Task 1", prompt: "Do task 1", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Direct" };

        await implementationPhase(tracker, ["/my-profiles", "/extra-profiles"], plan, "/cwd", 2, "/workdir");

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.profilesDirs).toEqual(["/my-profiles", "/extra-profiles"]);
    });

    it("uses correct getStepsForTask callback for code tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Code task", prompt: "Implement it", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Test" };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const getStepsForTask = ctorOptions.getStepsForTask as (task: Record<string, unknown>) => unknown[];
        const codeSteps = getStepsForTask({ isCode: true });
        expect(codeSteps).toHaveLength(4);
        expect((codeSteps as { name: string }[]).map((s) => s.name)).toEqual(["write-tests", "review-tests", "execute", "review"]);
    });

    it("uses correct getStepsForTask callback for non-code tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Doc task", prompt: "Update docs", profile: "implementer", files: ["README.md"], dependencies: [], is_code: false }], strategy: "Non-code" };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const getStepsForTask = ctorOptions.getStepsForTask as (task: Record<string, unknown>) => unknown[];
        const nonCodeSteps = getStepsForTask({ isCode: false });
        expect(nonCodeSteps).toHaveLength(2);
        expect((nonCodeSteps as { name: string }[]).map((s) => s.name)).toEqual(["execute", "review"]);
    });

    it("handles LanePool run resolving", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Task 1", prompt: "Do task 1", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Sequential" };
        mockLanePoolRun.mockResolvedValueOnce({ completedTasks: 1, failedTasks: 0 });

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");
        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
    });

    it("handles LanePool run with errors", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Failing task", prompt: "Do it", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Test" };
        mockLanePoolRun.mockResolvedValueOnce({ completedTasks: 0, failedTasks: 1 });

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");
        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
    });

    it("passes workDir as sessionBaseDir", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Task 1", prompt: "Do task 1", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }], strategy: "Test" };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/my-workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.sessionBaseDir).toBe("/my-workdir/sessions");
    });

    it("adds tasks to tracker before running pool", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [{ id: "t1", title: "Task 1", prompt: "Do task 1", profile: "implementer", files: ["src/a.ts"], dependencies: [], is_code: true }, { id: "t2", title: "Task 2", prompt: "Do task 2", profile: "implementer", files: ["src/b.ts"], dependencies: ["t1"], is_code: true }], strategy: "Sequential" };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const taskTracker = ctorOptions.taskTracker as { getAllTasks: () => unknown[] };
        const allTasks = taskTracker.getAllTasks();
        expect(allTasks).toHaveLength(2);
    });

    it("defaults maxConcurrentLanes to 5 when not specified", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = { tasks: [], strategy: "none" };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", undefined, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.maxConcurrentLanes).toBe(5);
    });
});

// ─── finalReviewPhase ───────────────────────────────────────────────────────

describe("finalReviewPhase", () => {
    /** Clean FinalReviewResult keyed off the reviewer's dimension. */
    const cleanResult = (taskId: string) => ({
        dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""),
        applicable: true,
        notApplicableReason: "",
        summary: "No issues",
        findings: [],
    });
    const isReviewerCall = (taskId: string) => /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId);

    it("returns true when no issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (typeof taskId === "string" && isReviewerCall(taskId)) return cleanResult(taskId);
            return {};
        });

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir", 3);
        expect(clean).toBe(true);
        // 5 reviewers run as parallel lanes; one clean pass each = 5 calls.
        const finalReviewCalls = mockRunStepTask.mock.calls.filter((c: unknown[]) => isReviewerCall((c[0] as Record<string, unknown>).taskId?.toString() ?? ""));
        expect(finalReviewCalls).toHaveLength(5);
    });

    it("spawns fixers for critical issues and returns true when fixed", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (typeof taskId !== "string") return {};
            // Round 0: only the efficiency reviewer reports a critical finding.
            if (taskId === "efficiency-reviewer-round-0") {
                return { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "Needs fixes", findings: [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Why it matters", fixPrompt: "Fix it by ..." }] };
            }
            // All other reviewers (and the efficiency review-fixes pass) are clean.
            if (isReviewerCall(taskId)) return cleanResult(taskId);
            return {};
        });

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir", 3);
        expect(clean).toBe(true);
        // 5 initial reviews + 1 efficiency review-fixes pass = 6 calls.
        const finalReviewCalls = mockRunStepTask.mock.calls.filter((c: unknown[]) => isReviewerCall((c[0] as Record<string, unknown>).taskId?.toString() ?? ""));
        expect(finalReviewCalls).toHaveLength(6);
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
    });

    it("returns true when only low-severity issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (typeof taskId !== "string") return {};
            // efficiency reviewer reports a LOW finding (non-actionable); rest clean.
            if (taskId === "efficiency-reviewer-round-0") {
                return { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "Minor nit", findings: [{ id: "f1", severity: "low", file: "src/a.ts", title: "Formatting", description: "Nit", fixPrompt: "Fix" }] };
            }
            if (isReviewerCall(taskId)) return cleanResult(taskId);
            return {};
        });

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir", 3);
        expect(clean).toBe(true);
        expect(mockLanePoolCtor).not.toHaveBeenCalled();
    });

    it("gives up after max fix rounds and returns false", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (typeof taskId !== "string") return {};
            // Every reviewer every round reports a critical finding.
            if (isReviewerCall(taskId)) {
                return { dimension: cleanResult(taskId).dimension, applicable: true, notApplicableReason: "", summary: "Still broken", findings: [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Persistent bug", description: "Why", fixPrompt: "Fix it" }] };
            }
            return {};
        });

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir", 3);
        expect(clean).toBe(false);
        // Every lane stays dirty: 5 lanes × (1 review + 3 review-fixes passes)
        // = 5 × 4 = 20 calls; 5 lanes × 3 fixer pools = 15 pools.
        const finalReviewCalls = mockRunStepTask.mock.calls.filter((c: unknown[]) => isReviewerCall((c[0] as Record<string, unknown>).taskId?.toString() ?? ""));
        expect(finalReviewCalls).toHaveLength(20);
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(15);
    });
});

// ─── run ─────────────────────────────────────────────────────────────────────

describe("run", () => {
    it("orchestrates all phases in order", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Found everything", gaps: [] };
            if (taskId === "planner") return { tasks: [{ id: "t1", title: "Implement", prompt: "Do it", profile: "implementer", files: ["src/core.ts"], dependencies: [], is_code: true }], strategy: "Direct approach" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "Plan approved", suggestions: [] };
            return smartRunStepTask(opts);
        });
        setupPromptMocks();

        await run("Build a feature", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
        expect(state.completedPhaseIds).toContain("scouting");
        expect(state.completedPhaseIds).toContain("planning");
        expect(state.completedPhaseIds).toContain("implementing");
        expect(state.completedPhaseIds).toContain("review");
    }, 30000);

    it("retries scouting when not ready", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        let scoutingReviewCalls = 0;
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [{ topic: "a", rationale: "A", files: [] }] };
            if (taskId === "scouting-reviewer") {
                scoutingReviewCalls++;
                if (scoutingReviewCalls <= 1) return { ready: false, research: "Partial", gaps: [{ topic: "need more", rationale: "Need more investigation", files: [] }] };
                return { ready: true, research: "Complete", gaps: [] };
            }
            if (taskId === "planner") return { tasks: [], strategy: "No tasks needed" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            return smartRunStepTask(opts);
        });
        setupPromptMocks();

        await run("Build something", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("retries planning when plan is rejected", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        let planReviewCalls = 0;
        let plannerCalls = 0;
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Done", gaps: [] };
            if (taskId === "plan-reviewer") {
                planReviewCalls++;
                if (planReviewCalls <= 1) return { ready: false, feedback: "Plan is too vague", suggestions: ["Add tasks"] };
                return { ready: true, feedback: "Better", suggestions: [] };
            }
            if (taskId === "planner") {
                plannerCalls++;
                if (plannerCalls <= 1) return { tasks: [], strategy: "Bad plan" };
                return { tasks: [{ id: "t1", title: "Real task", prompt: "Do it", profile: "implementer", files: [], dependencies: [], is_code: true }], strategy: "Better plan" };
            }
            return smartRunStepTask(opts);
        });
        setupPromptMocks();

        await run("Fix the bug", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("creates a new tracker when no saved state exists", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "ok", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "ok", suggestions: [] };
            return smartRunStepTask(opts);
        });
        setupPromptMocks();

        await run("Test task", { profilesDir: "/profiles", cwd: "/project", workDir });

        const exists = await fs.stat(path.join(workDir, ".engin-state.json"));
        expect(exists.isFile()).toBe(true);
    }, 30000);

    it("resumes from saved state", async () => {
        const workDir = tmpDir();

        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setWorkflowData({ scoutingReports: [{ summary: "existing report" }] });
        tracker.setPhase("planning");
        await tracker.save();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "From saved reports", gaps: [] };
            if (taskId === "planner") return { tasks: [{ id: "t1", title: "Task", prompt: "Do it", profile: "implementer", files: [], dependencies: [], is_code: true }], strategy: "Strategy" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            return smartRunStepTask(opts);
        });
        mockPromptForStructured.mockReset();
        mockPromptForStructured.mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Done", issues: [] }, attempts: 1 });

        await run("Resumed task", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
        expect(state.taskPrompt).toBe("Resumed task");
    }, 30000);

    it("saves state after each phase", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "ok", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "ok", suggestions: [] };
            return smartRunStepTask(opts);
        });
        setupPromptMocks();

        await run("Test", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("completes the planning phase and persists the plan", async () => {
        const workDir = tmpDir();

        // Defaults: smartRunMultiStepTask writes plan.json + returns an approved review.
        setupPromptMocks();

        await run("Test task", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.workflowData?.plan).toBeDefined();
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("preserves plan on exhausted planning rounds", async () => {
        const workDir = tmpDir();

        // Simulate the reviewer never approving: runMultiStepTask exhausts its
        // retries and planningPhase proceeds anyway with the captured plan.
        mockRunMultiStepTask.mockReset();
        mockRunMultiStepTask.mockImplementation(async (opts: Record<string, unknown>) => {
            const steps = opts.steps as Array<Record<string, unknown>>;
            const results: unknown[] = [];
            for (const step of steps) {
                if (typeof step.prompt === "function") await step.prompt(results);
                if (typeof step.validateOutput === "function") {
                    const allowed = (step.allowedWriteDirs as string[] | undefined)?.[0];
                    if (allowed) {
                        await fs.mkdir(allowed, { recursive: true });
                        await fs.writeFile(path.join(allowed, "plan.json"), JSON.stringify(DEFAULT_PLAN, null, 2));
                    }
                    await step.validateOutput();
                }
                results.push(step.stepName === "review-plan" ? { ready: false, feedback: "Not good enough", suggestions: [] } : undefined);
            }
            return { results, approved: false };
        });
        setupPromptMocks();

        await run("Fix something", { profilesDir: "/profiles", cwd: "/project", workDir });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);
});

afterAll(() => {
    mock.module("@harms-haus/engin-engine", () => realModule);
});
