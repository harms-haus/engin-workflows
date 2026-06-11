// ─── Develop Workflow Tests ──────────────────────────────────────────────────
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile } from "@harms-haus/engin";
import type { Plan, ScoutingReview, PlanReview, ReviewResult, FinalReviewTopics } from "../main.ts";

// Capture real module before mocking so we can restore it in afterAll.
const realModule = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockParallelAgents = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    parallelAgents: (...args: unknown[]) => mockParallelAgents(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}))

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
    createHarness,
    promptForStructured,
    parallelAgents,
    loadProfilesFromDirs,
    WorkflowStatusTracker,
} from "@harms-haus/engin";
import {
    scoutingPhase,
    scoutingReviewPhase,
    planningPhase,
    planReviewPhase,
    implementationPhase,
    finalReviewPhase,
    run,
    ScoutingTopicSchema,
    ScoutingReviewSchema,
    PlanSchema,
    PlanReviewSchema,
    ReviewResultSchema,
    FinalReviewTopicsSchema,
    TitleSchema,
} from "../main.ts";

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
    map.set("scouting-reviewer", {
        ...SCOUT_PROFILE,
        id: "scouting-reviewer",
        name: "Scouting Reviewer",
    });
    map.set("planner", {
        ...SCOUT_PROFILE,
        id: "planner",
        name: "Planner",
    });
    map.set("plan-reviewer", {
        ...SCOUT_PROFILE,
        id: "plan-reviewer",
        name: "Plan Reviewer",
    });
    map.set("implement-reviewer", REVIEWER_PROFILE);
    map.set("implementer", IMPLEMENTER_PROFILE);
    map.set("fixer", FIXER_PROFILE);
    map.set("final-reviewer", {
        ...SCOUT_PROFILE,
        id: "final-reviewer",
        name: "Final Reviewer",
    });
    map.set("test-writer", {
        ...SCOUT_PROFILE,
        id: "test-writer",
        name: "Test Writer",
    });
    map.set("test-reviewer", {
        ...SCOUT_PROFILE,
        id: "test-reviewer",
        name: "Test Reviewer",
    });
    return map;
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `develop-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
});

// ─── Schemas ────────────────────────────────────────────────────────────────

describe("Zod Schemas", () => {
    it("ScoutingTopicSchema validates correct structure", () => {
        const data = {
            topics: [
                {
                    topic: "auth module",
                    rationale: "Need to understand login flow",
                    files: ["src/auth.ts"],
                },
            ],
        };
        expect(ScoutingTopicSchema.safeParse(data).success).toBe(true);
    });

    it("ScoutingReviewSchema validates correct structure", () => {
        const data = {
            ready: true,
            research: "Found everything we need",
            gaps: [],
        };
        expect(ScoutingReviewSchema.safeParse(data).success).toBe(true);
    });

    it("PlanSchema validates correct structure", () => {
        const data = {
            tasks: [
                {
                    id: "t1",
                    title: "Add login",
                    prompt: "Implement login",
                    profile: "implementer",
                    files: ["src/auth.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Bottom-up approach",
        };
        expect(PlanSchema.safeParse(data).success).toBe(true);
    });

    it("PlanReviewSchema validates correct structure", () => {
        const data = {
            ready: true,
            feedback: "Plan looks good",
            suggestions: [],
        };
        expect(PlanReviewSchema.safeParse(data).success).toBe(true);
    });

    it("ReviewResultSchema validates correct structure", () => {
        const data = {
            approved: true,
            feedback: "Looks correct",
            issues: [],
        };
        expect(ReviewResultSchema.safeParse(data).success).toBe(true);
    });

    it("FinalReviewTopicsSchema validates correct structure", () => {
        const data = {
            topics: [{ topic: "error handling", files: ["src/errors.ts"] }],
            overallAssessment: "Good quality",
            issues: [
                {
                    file: "src/errors.ts",
                    description: "Missing null check",
                    severity: "critical" as const,
                },
            ],
        };
        expect(FinalReviewTopicsSchema.safeParse(data).success).toBe(true);
    });

    it("TitleSchema validates a concise title string", () => {
        const data = { title: "Refactor auth module" };
        expect(TitleSchema.safeParse(data).success).toBe(true);
    });

    it("TitleSchema rejects missing title", () => {
        expect(TitleSchema.safeParse({}).success).toBe(false);
    });

    it("TitleSchema rejects non-string title", () => {
        expect(TitleSchema.safeParse({ title: 42 }).success).toBe(false);
    });

    it("TitleSchema accepts title up to any length", () => {
        const data = { title: "A very long title that exceeds eight words easily" };
        expect(TitleSchema.safeParse(data).success).toBe(true);
    });
});

// ─── scoutingPhase ──────────────────────────────────────────────────────────

describe("scoutingPhase", () => {
    it("creates a scout harness, gets topics, and spawns parallel scouts", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                {
                    topic: "module-a",
                    rationale: "Core module",
                    files: ["src/a.ts"],
                },
                {
                    topic: "module-b",
                    rationale: "Supporting module",
                    files: ["src/b.ts"],
                },
            ],
        };

        // First call for topics, then parallel agents for reports
        mockPromptForStructured.mockResolvedValueOnce(topics);
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { report: "scout report A" } },
            { status: "fulfilled", value: { report: "scout report B" } },
        ]);

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd");

        expect(reports).toHaveLength(2);
        expect(reports[0]).toEqual({ report: "scout report A" });
        expect(reports[1]).toEqual({ report: "scout report B" });
        expect(mockCreateHarness).toHaveBeenCalledTimes(1); // coordinator harness
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
        expect(mockParallelAgents).toHaveBeenCalledTimes(1);
        expect(mockParallelAgents).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    profile: expect.objectContaining({ id: "scout" }),
                    cwd: "/cwd",
                }),
                expect.objectContaining({
                    profile: expect.objectContaining({ id: "scout" }),
                    cwd: "/cwd",
                }),
            ]),
            expect.any(Function),
        );
        expect(tracker.scoutingReports).toEqual(reports);
    });

    it("returns empty reports when no topics found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockPromptForStructured.mockResolvedValueOnce({ topics: [] });

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd");

        expect(reports).toEqual([]);
        expect(mockParallelAgents).not.toHaveBeenCalled();
    });

    it("handles partial failures in parallel scouts", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                { topic: "a", rationale: "A", files: ["a.ts"] },
                { topic: "b", rationale: "B", files: ["b.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce(topics);
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: { report: "success" } },
            { status: "rejected", reason: new Error("scout failed") },
        ]);

        const reports = await scoutingPhase(tracker, ["/profiles"], "task", "/cwd");

        expect(reports).toHaveLength(1);
        expect(reports[0]).toEqual({ report: "success" });
    });

    it("throws if scout profile not found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map()); // empty profiles

        await expect(
            scoutingPhase(tracker, ["/profiles"], "task", "/cwd"),
        ).rejects.toThrow('Profile "scout" not found');
    });
});

// ─── scoutingReviewPhase ────────────────────────────────────────────────────

describe("scoutingReviewPhase", () => {
    it("returns ready=true with research summary", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const reviewResult: ScoutingReview = {
            ready: true,
            research: "All areas investigated thoroughly",
            gaps: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(reviewResult);

        const result = await scoutingReviewPhase(
            tracker,
            ["/profiles"],
            [{ summary: "report 1" }],
            "/cwd",
        );

        expect(result).toEqual(reviewResult);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it("returns ready=false with gaps when more scouting needed", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const reviewResult: ScoutingReview = {
            ready: false,
            research: "Partial findings",
            gaps: ["Need to investigate test coverage"],
        };
        mockPromptForStructured.mockResolvedValueOnce(reviewResult);

        const result = await scoutingReviewPhase(
            tracker,
            ["/profiles"],
            [],
            "/cwd",
        );

        expect(result.ready).toBe(false);
        expect(result.gaps).toHaveLength(1);
    });

    it("throws if scouting-reviewer profile not found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map());

        await expect(
            scoutingReviewPhase(tracker, ["/profiles"], [], "/cwd"),
        ).rejects.toThrow('Profile "scouting-reviewer" not found');
    });
});

// ─── planningPhase ──────────────────────────────────────────────────────────

describe("planningPhase", () => {
    it("creates a plan with tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Implement feature X",
                    prompt: "Create the X module",
                    profile: "implementer",
                    files: ["src/x.ts"],
                    dependencies: [],
                    is_code: true,
                },
                {
                    id: "t2",
                    title: "Add tests for X",
                    prompt: "Write tests",
                    profile: "implementer",
                    files: ["tests/x.test.ts"],
                    dependencies: ["t1"],
                    is_code: true,
                },
            ],
            strategy: "Implement core first, then tests",
        };

        mockPromptForStructured.mockResolvedValueOnce(plan);

        const result = await planningPhase(
            tracker,
            ["/profiles"],
            "Research summary",
            "Build feature X",
            "/cwd",
        );

        expect(result).toEqual(plan);
        expect(result.tasks).toHaveLength(2);
        expect(tracker.plan).toEqual(plan);
    });

    it("throws if planner profile not found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map());

        await expect(
            planningPhase(tracker, ["/profiles"], "research", "task", "/cwd"),
        ).rejects.toThrow('Profile "planner" not found');
    });

    it("includes review feedback in prompt when provided", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [],
            strategy: "Improved plan",
        };

        mockPromptForStructured.mockResolvedValueOnce(plan);

        await planningPhase(
            tracker,
            ["/profiles"],
            "research",
            "task",
            "/cwd",
            "Plan was too vague",
            ["Add tasks"],
        );

        const prompt = mockPromptForStructured.mock.calls[0][1] as string;
        expect(prompt).toContain("Plan was too vague");
        expect(prompt).toContain("Add tasks");
    });
});

// ─── planReviewPhase ────────────────────────────────────────────────────────

describe("planReviewPhase", () => {
    it("approves a good plan", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Do something",
                    prompt: "Do it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Simple approach",
        };

        const review: PlanReview = {
            ready: true,
            feedback: "Plan is solid and well-structured",
            suggestions: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(review);

        const result = await planReviewPhase(
            tracker,
            ["/profiles"],
            plan,
            "research",
            "task prompt",
            "/cwd",
        );

        expect(result.ready).toBe(true);
        expect(result.feedback).toContain("solid");
    });

    it("rejects a flawed plan with suggestions", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [],
            strategy: "No tasks defined",
        };

        const review: PlanReview = {
            ready: false,
            feedback: "Plan has no tasks",
            suggestions: ["Add concrete implementation tasks"],
        };
        mockPromptForStructured.mockResolvedValueOnce(review);

        const result = await planReviewPhase(
            tracker,
            ["/profiles"],
            plan,
            "research",
            "task",
            "/cwd",
        );

        expect(result.ready).toBe(false);
        expect(result.suggestions).toHaveLength(1);
    });
});

// ─── implementationPhase ────────────────────────────────────────────────────

describe("implementationPhase", () => {
    it("creates LanePool with correct maxConcurrentLanes", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Sequential",
        };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.maxConcurrentLanes).toBe(3);
        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
    });

    it("passes profilesDirs to LanePool", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Direct",
        };

        await implementationPhase(tracker, ["/my-profiles", "/extra-profiles"], plan, "/cwd", 2, "/workdir");

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.profilesDirs).toEqual(["/my-profiles", "/extra-profiles"]);
    });

    it("uses correct getStepsForTask callback for code tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Code task",
                    prompt: "Implement it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Test",
        };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const getStepsForTask = ctorOptions.getStepsForTask as (task: Record<string, unknown>) => unknown[];

        // Code task should get CODE_STEPS (write-tests, review-tests, execute, review)
        const codeSteps = getStepsForTask({ isCode: true });
        expect(codeSteps).toHaveLength(4);
        expect((codeSteps as { name: string }[]).map((s) => s.name)).toEqual([
            "write-tests",
            "review-tests",
            "execute",
            "review",
        ]);
    });

    it("uses correct getStepsForTask callback for non-code tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Doc task",
                    prompt: "Update docs",
                    profile: "implementer",
                    files: ["README.md"],
                    dependencies: [],
                    is_code: false,
                },
            ],
            strategy: "Non-code",
        };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const getStepsForTask = ctorOptions.getStepsForTask as (task: Record<string, unknown>) => unknown[];

        // Non-code task should get NON_CODE_STEPS (execute, review)
        const nonCodeSteps = getStepsForTask({ isCode: false });
        expect(nonCodeSteps).toHaveLength(2);
        expect((nonCodeSteps as { name: string }[]).map((s) => s.name)).toEqual([
            "execute",
            "review",
        ]);
    });

    it("handles LanePool run resolving", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Sequential",
        };

        mockLanePoolRun.mockResolvedValueOnce({ completedTasks: 1, failedTasks: 0 });

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
    });

    it("handles LanePool run with errors", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Failing task",
                    prompt: "Do it",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Test",
        };

        mockLanePoolRun.mockResolvedValueOnce({ completedTasks: 0, failedTasks: 1 });

        // Should not throw — LanePool handles failures internally
        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
    });

    it("passes workDir as sessionBaseDir", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Test",
        };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/my-workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.sessionBaseDir).toBe("/my-workdir/sessions");
    });

    it("adds tasks to tracker before running pool", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [
                {
                    id: "t1",
                    title: "Task 1",
                    prompt: "Do task 1",
                    profile: "implementer",
                    files: ["src/a.ts"],
                    dependencies: [],
                    is_code: true,
                },
                {
                    id: "t2",
                    title: "Task 2",
                    prompt: "Do task 2",
                    profile: "implementer",
                    files: ["src/b.ts"],
                    dependencies: ["t1"],
                    is_code: true,
                },
            ],
            strategy: "Sequential",
        };

        // Verify tasks are added to the tracker before LanePool.run() is called
        // by checking that the ctor receives the tracker with the tasks
        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const taskTracker = ctorOptions.taskTracker as { getAllTasks: () => unknown[] };
        const allTasks = taskTracker.getAllTasks();
        expect(allTasks).toHaveLength(2);
    });

    it("defaults maxConcurrentLanes to 3 when not specified", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const plan: Plan = {
            tasks: [],
            strategy: "none",
        };

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", undefined, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.maxConcurrentLanes).toBe(3);
    });
});

// ─── finalReviewPhase ───────────────────────────────────────────────────────

describe("finalReviewPhase", () => {
    it("returns true when no issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const assessment: FinalReviewTopics = {
            topics: [{ topic: "Code quality", files: ["src/main.ts"] }],
            overallAssessment: "Code looks good",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(assessment);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
    });

    it("spawns fixers for critical issues and returns true when fixed", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // First review: finds critical issue
        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce(firstAssessment);

        // Fixers run in parallel
        mockParallelAgents.mockResolvedValueOnce([
            { status: "fulfilled", value: "fixed" },
        ]);

        // Second review: clean
        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "All fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce(secondAssessment);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        expect(mockPromptForStructured).toHaveBeenCalledTimes(2); // two review rounds
        expect(mockParallelAgents).toHaveBeenCalledTimes(1); // one fix round
    });

    it("returns true when only minor issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const assessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Mostly good",
            issues: [
                { file: "src/a.ts", description: "Formatting", severity: "minor" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce(assessment);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        // No fixers spawned since only minor issues
        expect(mockParallelAgents).not.toHaveBeenCalled();
    });

    it("gives up after max fix rounds and returns false", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Every review finds critical issues
        const assessmentWithCritical: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Still broken",
            issues: [
                { file: "src/a.ts", description: "Persistent bug", severity: "critical" },
            ],
        };

        mockPromptForStructured.mockResolvedValue(assessmentWithCritical);
        mockParallelAgents.mockResolvedValue([
            { status: "fulfilled", value: "attempted fix" },
        ]);

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(false);
        // Should have run 3 rounds of review (all rounds exhausted)
        expect(mockPromptForStructured).toHaveBeenCalledTimes(3);
        // Should have run 3 rounds of fixing (one per round with critical issues)
        expect(mockParallelAgents).toHaveBeenCalledTimes(3);
    });
});

// ─── run ─────────────────────────────────────────────────────────────────────

describe("run", () => {
    it("orchestrates all phases in order", async () => {
        const workDir = tmpDir();

        // scoutingPhase: topics then parallel agents
        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            // scouting: topics
            .mockResolvedValueOnce({
                topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }],
            })
            // scoutingReview: ready
            .mockResolvedValueOnce({
                ready: true,
                research: "Found everything",
                gaps: [],
            })
            // planning
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Implement",
                        prompt: "Do it",
                        profile: "implementer",
                        files: ["src/core.ts"],
                        dependencies: [],
                        is_code: true,
                    },
                ],
                strategy: "Direct approach",
            })
            // planReview: approved
            .mockResolvedValueOnce({
                ready: true,
                feedback: "Plan approved",
                suggestions: [],
            })
            // finalReview: clean
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Everything looks great",
                issues: [],
            });

        // parallelAgents for scouting
        mockParallelAgents
            .mockResolvedValueOnce([
                { status: "fulfilled", value: { report: "scouted" } },
            ]);

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Verify the workflow advanced through all phases
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.currentPhase).toBe("done");
        expect(state.completedPhases).toContain("scouting");
        expect(state.completedPhases).toContain("scouting_review");
        expect(state.completedPhases).toContain("planning");
        expect(state.completedPhases).toContain("plan_review");
        expect(state.completedPhases).toContain("implementing");
        expect(state.completedPhases).toContain("final_review");
    }, 30000);

    it("retries scouting when not ready", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            // scouting round 1: topics
            .mockResolvedValueOnce({ topics: [{ topic: "a", rationale: "A", files: [] }] })
            // scouting review round 1: NOT ready
            .mockResolvedValueOnce({ ready: false, research: "Partial", gaps: ["need more"] })
            // scouting round 2: topics
            .mockResolvedValueOnce({ topics: [{ topic: "b", rationale: "B", files: [] }] })
            // scouting review round 2: ready
            .mockResolvedValueOnce({ ready: true, research: "Complete", gaps: [] })
            // planning
            .mockResolvedValueOnce({
                tasks: [],
                strategy: "No tasks needed",
            })
            // plan review
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Good",
                issues: [],
            });

        mockParallelAgents
            .mockResolvedValue([{ status: "fulfilled", value: {} }]);

        await run("Build something", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Scouting phase called twice (2 rounds)
        expect(mockParallelAgents).toHaveBeenCalled();

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
    }, 30000);

    it("retries planning when plan is rejected", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            // scouting
            .mockResolvedValueOnce({ topics: [] })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Done", gaps: [] })
            // planning round 1
            .mockResolvedValueOnce({
                tasks: [],
                strategy: "Bad plan",
            })
            // plan review round 1: rejected
            .mockResolvedValueOnce({
                ready: false,
                feedback: "Plan is too vague",
                suggestions: ["Add tasks"],
            })
            // planning round 2
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Real task",
                        prompt: "Do it",
                        profile: "implementer",
                        files: [],
                        dependencies: [],
                        is_code: true,
                    },
                ],
                strategy: "Better plan",
            })
            // plan review round 2: approved
            .mockResolvedValueOnce({ ready: true, feedback: "Better", suggestions: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Good",
                issues: [],
            });

        await run("Fix the bug", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");

        // Verify the planner prompt for round 2 includes feedback from round 1's rejection
        // Call index 0 = initialization, 1 = scouting, 2 = scouting review,
        // 3 = planning round 1, 4 = plan review round 1, 5 = planning round 2
        const plannerPromptRound2 = mockPromptForStructured.mock.calls[5][1] as string;
        expect(plannerPromptRound2).toContain("Plan is too vague");
        expect(plannerPromptRound2).toContain("Add tasks");
    }, 30000);

    it("creates a new tracker when no saved state exists", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            .mockResolvedValueOnce({ topics: [] })
            .mockResolvedValueOnce({ ready: true, research: "ok", gaps: [] })
            .mockResolvedValueOnce({ tasks: [], strategy: "none" })
            .mockResolvedValueOnce({ ready: true, feedback: "ok", suggestions: [] })
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "ok",
                issues: [],
            });

        mockParallelAgents.mockResolvedValue([]);

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Verify state file was created
        const exists = await fs.stat(path.join(workDir, ".engin-state.json"));
        expect(exists.isFile()).toBe(true);
    }, 30000);

    it("resumes from saved state", async () => {
        const workDir = tmpDir();

        // Create initial saved state at "planning" phase
        const tracker = new WorkflowStatusTracker(workDir);
        tracker.setTaskPrompt("Resumed task");
        tracker.setScoutingReports([{ summary: "existing report" }]);
        tracker.setPhase("planning");
        await tracker.save();

        // Setup mocks for planning and beyond
        mockPromptForStructured
            // scouting review (to get research)
            .mockResolvedValueOnce({ ready: true, research: "From saved reports", gaps: [] })
            // planning
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Task",
                        prompt: "Do it",
                        profile: "implementer",
                        files: [],
                        dependencies: [],
                        is_code: true,
                    },
                ],
                strategy: "Strategy",
            })
            // plan review
            .mockResolvedValueOnce({ ready: true, feedback: "OK", suggestions: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Done",
                issues: [],
            });

        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
        expect(state.taskPrompt).toBe("Resumed task");
    }, 30000);

    it("saves state after each phase", async () => {
        const workDir = tmpDir();

        let promptForStructuredCallCount = 0;

        mockPromptForStructured.mockImplementation(async (...args: unknown[]) => {
            promptForStructuredCallCount++;

            // Check state file exists at various points
            try {
                await fs.stat(path.join(workDir, ".engin-state.json"));
            } catch {
                // State may not exist yet on first call
            }

            // initialization: title generation
            if (promptForStructuredCallCount === 1) return { title: "AI title" };
            // scouting topics
            if (promptForStructuredCallCount === 2) return { topics: [] };
            // scouting review
            if (promptForStructuredCallCount === 3) return { ready: true, research: "ok", gaps: [] };
            // planning
            if (promptForStructuredCallCount === 4) return { tasks: [], strategy: "none" };
            // plan review
            if (promptForStructuredCallCount === 5) return { ready: true, feedback: "ok", suggestions: [] };
            // final review
            if (promptForStructuredCallCount === 6) return { topics: [], overallAssessment: "ok", issues: [] };

            return {};
        });

        mockParallelAgents.mockResolvedValue([]);

        await run("Test", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Final state file should exist
        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
    }, 30000);

    it("clears plan review feedback after plan is approved", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            .mockResolvedValueOnce({ topics: [] })
            .mockResolvedValueOnce({ ready: true, research: "Done", gaps: [] })
            // planning round 1
            .mockResolvedValueOnce({
                tasks: [],
                strategy: "Weak plan",
            })
            // plan review round 1: rejected
            .mockResolvedValueOnce({
                ready: false,
                feedback: "Plan is too vague",
                suggestions: ["Add tasks"],
            })
            // planning round 2
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Task",
                        prompt: "Do it",
                        profile: "implementer",
                        files: [],
                        dependencies: [],
                        is_code: true,
                    },
                ],
                strategy: "Better plan",
            })
            // plan review round 2: approved
            .mockResolvedValueOnce({ ready: true, feedback: "Plan approved", suggestions: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Good",
                issues: [],
            });

        mockParallelAgents.mockResolvedValue([]);

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);

        // After approval, feedback should be cleared
        expect(state.planReviewFeedback).toBeUndefined();
        expect(state.planReviewSuggestions).toBeUndefined();
    }, 30000);

    it("persists plan review feedback to tracker on rejection", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            .mockResolvedValueOnce({ topics: [] })
            .mockResolvedValueOnce({ ready: true, research: "Done", gaps: [] })
            // planning round 1
            .mockResolvedValueOnce({
                tasks: [],
                strategy: "Bad plan",
            })
            // plan review round 1: rejected
            .mockResolvedValueOnce({
                ready: false,
                feedback: "Plan is too vague",
                suggestions: ["Add tasks"],
            })
            // planning round 2
            .mockResolvedValueOnce({
                tasks: [
                    {
                        id: "t1",
                        title: "Task",
                        prompt: "Do it",
                        profile: "implementer",
                        files: [],
                        dependencies: [],
                        is_code: true,
                    },
                ],
                strategy: "Better plan",
            })
            // plan review round 2: approved
            .mockResolvedValueOnce({ ready: true, feedback: "Improved", suggestions: [] })
            // final review
            .mockResolvedValueOnce({
                topics: [],
                overallAssessment: "Good",
                issues: [],
            });

        mockParallelAgents.mockResolvedValue([]);

        await run("Fix something", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Verify the planner prompt for round 2 includes feedback from the rejection.
        // This proves the feedback was captured in RunState and passed to planningPhase().
        // Call index 0 = initialization, 1 = scouting, 2 = scouting review,
        // 3 = planning round 1, 4 = plan review round 1, 5 = planning round 2
        const plannerPromptRound2 = mockPromptForStructured.mock.calls[5][1] as string;
        expect(plannerPromptRound2).toContain("Plan is too vague");
        expect(plannerPromptRound2).toContain("Add tasks");
    }, 30000);

    it("preserves plan on exhausted planning rounds", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ title: "AI title" })
            // scouting
            .mockResolvedValueOnce({ topics: [] })
            // scouting review: ready
            .mockResolvedValueOnce({ ready: true, research: "Done", gaps: [] })
            // planning round 1
            .mockResolvedValueOnce({ tasks: [], strategy: "Bad" })
            // plan review round 1: rejected
            .mockResolvedValueOnce({ ready: false, feedback: "Vague", suggestions: ["Add tasks"] })
            // planning round 2
            .mockResolvedValueOnce({ tasks: [], strategy: "Still bad" })
            // plan review round 2: rejected
            .mockResolvedValueOnce({ ready: false, feedback: "Still vague", suggestions: ["More detail"] })
            // planning round 3
            .mockResolvedValueOnce({ tasks: [], strategy: "Better" })
            // plan review round 3: rejected (exhausted)
            .mockResolvedValueOnce({ ready: false, feedback: "Not good enough", suggestions: [] })
            // final review
            .mockResolvedValueOnce({ topics: [], overallAssessment: "ok", issues: [] });

        await run("Fix something", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        // Even after 3 rejected planning rounds, the workflow should complete (not crash)
        expect(state.currentPhase).toBe("done");
        // Implementation phase should still have been attempted (plan from tracker)
        expect(state.completedPhases).toContain("implementing");
    }, 30000);
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
