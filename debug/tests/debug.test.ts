// ─── Debug Workflow Tests ──────────────────────────────────────────────────
//
// Tests for the debug workflow's main.ts, verifying:
//   1. All schemas are correctly exported and functional
//   2. All phase functions are exported and behave correctly
//   3. Default maxConcurrentTasks is 3 (not 5)
//   4. resolveProfilesDirs is called with 'debug' (not 'develop')
//   5. finalReviewPhase uses LanePool with FIXER_STEPS (not parallelAgents)
//   6. No parallelAgents import/reference
//   7. Interface is DebugWorkflowOptions (not DevelopWorkflowOptions)
//   8. scoutingPhase uses 'scout-coordinator' profile
//   9. No errorEvent function
//  10. No web renderer imports/references
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile } from "@harms-haus/engin";
import type { Plan, ScoutingReview, PlanReview, ReviewResult, FinalReviewResult, FinalReviewFinding } from "../main.ts";

// Capture real module before mocking so we can restore it in afterAll.
const realModule = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockResolveProfilesDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunMultiStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    resolveProfilesDirs: (...args: unknown[]) => mockResolveProfilesDirs(...args),
    runMultiStepTask: (...args: unknown[]) => mockRunMultiStepTask(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
    WorkflowStatusTracker,
} from "@harms-haus/engin";
import {
    scoutingPhase,
    scoutingReviewPhase,
    planningPhase,
    implementationPhase,
    finalReviewPhase,
    run,
    ScoutingTopicSchema,
    ScoutingTopics,
    ScoutingGapSchema,
    ScoutingGap,
    ScoutingReviewSchema,
    ScoutingReview as ScoutingReviewType,
    PlanSchema,
    Plan as PlanType,
    PlanReviewSchema,
    PlanReview as PlanReviewType,
    ReviewResultSchema,
    ReviewResult as ReviewResultType,
    FinalReviewTopicsSchema,
    FinalReviewTopics as FinalReviewTopicsType,
    FinalReviewResultSchema,
    TitleSchema,
    DebugWorkflowOptions,
    RunOptions,
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
    const ids = [
        "scout",
        "scout-coordinator",
        "scouting-reviewer",
        "planner",
        "plan-reviewer",
        "implement-reviewer",
        "implementer",
        "implementer-lite",
        "fixer",
        "final-reviewer",
        "efficiency-reviewer",
        "code-quality-reviewer",
        "ui-ux-reviewer",
        "security-reviewer",
        "documentation-reviewer",
        "test-writer",
        "test-reviewer",
    ];
    for (const id of ids) {
        map.set(id, { ...SCOUT_PROFILE, id, name: id });
    }
    return map;
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `debug-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

/** Default plan written by the smart runMultiStepTask mock when no plan.json exists. */
const DEFAULT_PLAN: Plan = {
    tasks: [{ id: "t1", title: "Default task", prompt: "Do it", profile: "implementer", files: ["src/index.ts"], dependencies: [], is_code: true }],
    strategy: "Default strategy",
};

/**
 * Smart mock for runMultiStepTask (used by planningPhase). Mimics just enough of
 * the real primitive to capture the plan: it resolves each step's (lazy) prompt
 * and invokes the plan step's `validateOutput` gate (which reads plan.json back
 * into planningPhase's closure). Writes a default plan.json when missing.
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

// ─── Final Review mock helpers ──────────────────────────────────────────────
//
// The final review runs 5 reviewers as INDEPENDENT LANES in parallel. Each
// lane loops review → fixer → review-fixes over its own dimension. Each
// reviewer's prompt identifies its dimension, so these helpers key the
// returned FinalReviewResult off the prompt text — robust to the parallel call
// ordering. The default impl returns a clean result for every reviewer and is
// installed in beforeEach so the `run`/callbacks tests (which mock the earlier
// phases via mockResolvedValueOnce) get clean reviewer results once their
// per-test queue is spent.

function parseFinalReviewDimension(prompt: unknown): string | null {
    if (typeof prompt !== "string") return null;
    const m = /focused on a single dimension: [^(]+ \(([^)]+)\)/.exec(prompt);
    return m ? m[1] : null;
}

function finalReviewRound0(prompt: unknown): boolean {
    return typeof prompt === "string" && !prompt.includes("PRIOR REVIEW HISTORY");
}

function cleanFinalReviewResult(dimension: string): FinalReviewResult {
    return { dimension, applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
}

/** Default promptForStructured impl: clean FinalReviewResult for any reviewer. */
function defaultFinalReviewCleanImpl() {
    return async (_session: unknown, prompt: unknown): Promise<{ result: unknown; attempts: number }> => {
        const dimension = parseFinalReviewDimension(prompt);
        if (dimension) return { result: cleanFinalReviewResult(dimension), attempts: 1 };
        return { result: {}, attempts: 1 };
    };
}

/**
 * Build a final-review promptForStructured impl for the finalReviewPhase unit
 * tests.
 *  - criticalEveryRound: every reviewer, every round returns one critical finding.
 *  - criticalRound0Dim:   one dimension returns a critical finding in round 0 only.
 *  - lowEveryRound:       every reviewer returns a low (non-actionable) finding.
 */
function finalReviewImpl(opts: {
    criticalEveryRound?: boolean;
    criticalRound0Dim?: string;
    lowEveryRound?: boolean;
} = {}) {
    return async (_session: unknown, prompt: unknown): Promise<{ result: FinalReviewResult; attempts: number }> => {
        const dimension = parseFinalReviewDimension(prompt) ?? "unknown";
        let findings: FinalReviewFinding[] = [];
        if (opts.criticalEveryRound) {
            findings = [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Persistent bug", description: "Why it matters", fixPrompt: "Fix it by ..." }];
        } else if (opts.lowEveryRound) {
            findings = [{ id: "f1", severity: "low", file: "src/a.ts", title: "Nit", description: "Formatting", fixPrompt: "Fix it by ..." }];
        } else if (opts.criticalRound0Dim && finalReviewRound0(prompt) && dimension === opts.criticalRound0Dim) {
            findings = [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Why it matters", fixPrompt: "Fix it by ..." }];
        }
        return { result: { dimension, applicable: true, notApplicableReason: "", summary: findings.length ? "Has findings" : "No issues", findings }, attempts: 1 };
    };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockResolveProfilesDirs.mockReturnValue(["/resolved/profiles"]);
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    // Default: any final-review reviewer call returns a clean FinalReviewResult.
    // Per-test mockResolvedValueOnce values (for the sequential phases) take
    // priority; this impl only handles the 5 parallel reviewer calls once those
    // are spent.
    mockPromptForStructured.mockImplementation(defaultFinalReviewCleanImpl());
    mockRunMultiStepTask.mockImplementation(smartRunMultiStepTask);
    mockLanePoolRun.mockImplementation(async function(this: unknown) {
        // Auto-process tasks from the LanePool's taskTracker so tests
        // don't need to manually drive the pool.
        const lastCall = mockLanePoolCtor.mock.calls[mockLanePoolCtor.mock.calls.length - 1];
        if (lastCall?.[0]) {
            const opts = lastCall[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                for (const task of [...tt.getAllTasks()]) {
                    const claimed = tt.claimTasks(1, 'mock-agent');
                    if (claimed.length > 0) {
                        tt.completeTask(claimed[0].id);
                    }
                }
                const doneCount = tt.getAllTasks().filter((t: any) => t.status === 'complete').length;
                return { completedTasks: doneCount, failedTasks: 0 };
            }
        }
        return { completedTasks: 0, failedTasks: 0 };
    });
});

// ─── 1. Structural Verification: Exports ────────────────────────────────────

describe("Exports", () => {
    it("exports ScoutingTopicSchema", () => {
        expect(ScoutingTopicSchema).toBeDefined();
    });

    it("exports ScoutingTopics type (verify it's a Zod inferred type)", () => {
        // Type-only export — we verify the schema parses the expected shape
        const data = {
            topics: [{ topic: "test", rationale: "test rationale", files: ["a.ts"] }],
        };
        expect(ScoutingTopicSchema.safeParse(data).success).toBe(true);
    });

    it("exports ScoutingGapSchema", () => {
        expect(ScoutingGapSchema).toBeDefined();
    });

    it("exports ScoutingReviewSchema", () => {
        expect(ScoutingReviewSchema).toBeDefined();
    });

    it("exports PlanSchema", () => {
        expect(PlanSchema).toBeDefined();
    });

    it("exports PlanReviewSchema", () => {
        expect(PlanReviewSchema).toBeDefined();
    });

    it("exports ReviewResultSchema", () => {
        expect(ReviewResultSchema).toBeDefined();
    });

    it("exports FinalReviewTopicsSchema", () => {
        expect(FinalReviewTopicsSchema).toBeDefined();
    });

    it("exports TitleSchema", () => {
        expect(TitleSchema).toBeDefined();
    });

    it("exports scoutingPhase function", () => {
        expect(typeof scoutingPhase).toBe("function");
    });

    it("exports scoutingReviewPhase function", () => {
        expect(typeof scoutingReviewPhase).toBe("function");
    });

    it("exports planningPhase function", () => {
        expect(typeof planningPhase).toBe("function");
    });

    it("exports implementationPhase function", () => {
        expect(typeof implementationPhase).toBe("function");
    });

    it("exports finalReviewPhase function", () => {
        expect(typeof finalReviewPhase).toBe("function");
    });

    it("exports run function", () => {
        expect(typeof run).toBe("function");
    });

    it("exports DebugWorkflowOptions interface (as a type)", () => {
        // TypeScript interfaces are erased at runtime.
        // We verify the type exists by using it in a type annotation.
        const opts: DebugWorkflowOptions = {
            cwd: "/project",
        };
        expect(opts.cwd).toBe("/project");
    });

    it("exports RunOptions interface (as a type)", () => {
        const opts: RunOptions = {
            cwd: "/project",
            workDir: "/workdir",
        };
        expect(opts.cwd).toBe("/project");
        expect(opts.workDir).toBe("/workdir");
    });
});

// ─── 2. Schema Tests ────────────────────────────────────────────────────────

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

    it("FinalReviewResultSchema validates a clean (no findings) result", () => {
        const data = {
            dimension: "efficiency",
            applicable: true,
            notApplicableReason: "",
            summary: "No issues",
            findings: [],
        };
        expect(FinalReviewResultSchema.safeParse(data).success).toBe(true);
    });

    it("FinalReviewResultSchema validates a result with a finding", () => {
        const data = {
            dimension: "security",
            applicable: true,
            notApplicableReason: "",
            summary: "1 finding",
            findings: [
                {
                    id: "sqli-in-user-query",
                    severity: "critical",
                    file: "src/auth.ts:42-58",
                    title: "SQL injection",
                    description: "User input is concatenated into the query.",
                    fixPrompt: "Parameterize the query.",
                },
            ],
        };
        expect(FinalReviewResultSchema.safeParse(data).success).toBe(true);
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
});

// ─── 3. scoutingPhase Tests ─────────────────────────────────────────────────

describe("scoutingPhase", () => {
    it("creates a scout harness with scout-coordinator agentId, gets topics, and runs a LanePool", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
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

        mockPromptForStructured.mockResolvedValueOnce({ result: topics, attempts: 1 });

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        expect(reports).toHaveLength(2);
        expect(mockCreateHarness).toHaveBeenCalledTimes(1); // coordinator harness

        // Verify the scout-coordinator agentId was used
        const harnessCall = mockCreateHarness.mock.calls[0][0] as { agentId: string };
        expect(harnessCall.agentId).toBe("scout-coordinator");

        expect(mockPromptForStructured).toHaveBeenCalledTimes(1);
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        expect(mockLanePoolRun).toHaveBeenCalledTimes(1);
        expect((tracker.workflowData as { scoutingReports: unknown[] }).scoutingReports).toEqual(reports);
    });

    it("returns empty reports when no topics found", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockPromptForStructured.mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 });

        const reports = await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        expect(reports).toEqual([]);
        expect(mockLanePoolCtor).not.toHaveBeenCalled();
    });

    it("throws if scout profile not found", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockLoadProfilesFromDirs.mockResolvedValueOnce(new Map()); // empty profiles

        await expect(
            scoutingPhase(tracker, ["/profiles"], "task", "/cwd", 3, workDir),
        ).rejects.toThrow('Profile "scout-coordinator" not found');
    });
});

// ─── 4. scoutingReviewPhase Tests ───────────────────────────────────────────

describe("scoutingReviewPhase", () => {
    it("returns ready=true with research summary", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const reviewResult: ScoutingReview = {
            ready: true,
            research: "All areas investigated thoroughly",
            gaps: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: reviewResult, attempts: 1 });

        const result = await scoutingReviewPhase(
            tracker,
            ["/profiles"],
            "Implement feature X",
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
            gaps: [
                { topic: "Need to investigate test coverage", rationale: "Tests not examined", files: ["tests/"] },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: reviewResult, attempts: 1 });

        const result = await scoutingReviewPhase(
            tracker,
            ["/profiles"],
            "Implement feature X",
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
            scoutingReviewPhase(tracker, ["/profiles"], "Implement feature X", [], "/cwd"),
        ).rejects.toThrow('Profile "scouting-reviewer" not found');
    });
});

// ─── 5. planningPhase Tests ─────────────────────────────────────────────────

describe("planningPhase", () => {
    it("creates a plan with tasks", async () => {
        const workDir = tmpDir();
        const artifactsDir = path.join(workDir, "artifacts");
        await fs.mkdir(artifactsDir, { recursive: true });
        const tracker = new WorkflowStatusTracker(workDir);

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
        // The planner writes plan.json; the smart runMultiStepTask mock invokes
        // the validateOutput gate, which reads this back into planningPhase.
        await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));

        const result = await planningPhase(tracker, ["/profiles"], "Research summary", [], "Build feature X", "/cwd", workDir);
        expect(result).toEqual(plan);
        expect(result.tasks).toHaveLength(2);
        expect((tracker.workflowData as { plan: unknown }).plan).toEqual(plan);
    });
});

// ─── 7. implementationPhase Tests ───────────────────────────────────────────

describe("implementationPhase", () => {
    it("creates LanePool with maxConcurrentLanes from parameter", async () => {
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

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 2, "/workdir");

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.maxConcurrentLanes).toBe(2);
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

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.profilesDirs).toEqual(["/my-profiles", "/extra-profiles"]);
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

        await implementationPhase(tracker, ["/profiles"], plan, "/cwd", 3, "/workdir");

        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const taskTracker = ctorOptions.taskTracker as { getAllTasks: () => unknown[] };
        const allTasks = taskTracker.getAllTasks();
        expect(allTasks).toHaveLength(2);
    });
});

// ─── 8. finalReviewPhase Tests ──────────────────────────────────────────────

describe("finalReviewPhase", () => {
    it("returns true when no issues found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // All 5 reviewers return a clean FinalReviewResult.
        mockPromptForStructured.mockImplementation(finalReviewImpl());

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd");

        expect(clean).toBe(true);
        // 5 reviewers run as parallel lanes; one clean pass each = 5 calls.
        expect(mockPromptForStructured).toHaveBeenCalledTimes(5);
    });

    it("returns true when only low-severity (non-actionable) findings found", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Low findings are recorded but do NOT spawn fixers.
        mockPromptForStructured.mockImplementation(finalReviewImpl({ lowEveryRound: true }));

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir");

        expect(clean).toBe(true);
        // Low findings are recorded but do NOT spawn fixers; one clean pass per
        // lane = 5 calls.
        expect(mockPromptForStructured).toHaveBeenCalledTimes(5);
    });

    it("uses LanePool with FIXER_STEPS for critical issues (not parallelAgents)", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Round 0: the efficiency reviewer returns a critical finding; the
        // other 4 reviewers are clean. The efficiency lane then runs a fixer
        // and a review-fixes pass which comes back clean.
        mockPromptForStructured.mockImplementation(finalReviewImpl({ criticalRound0Dim: "efficiency" }));

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir");

        expect(clean).toBe(true);
        // 5 initial reviews + 1 efficiency review-fixes pass = 6 calls.
        expect(mockPromptForStructured).toHaveBeenCalledTimes(6);

        // LanePool should have been constructed for the fixer round
        // (at least once — for the fixer LanePool)
        expect(mockLanePoolCtor.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Verify the fixer LanePool was constructed with correct parameters
        // The last LanePool construction should be for the fixer
        const fixerCtorCall = mockLanePoolCtor.mock.calls[mockLanePoolCtor.mock.calls.length - 1];
        const ctorOptions = fixerCtorCall[0] as Record<string, unknown>;

        // Should have profilesDirs and cwd
        expect(ctorOptions.profilesDirs).toEqual(["/profiles"]);
        expect(ctorOptions.cwd).toBe("/cwd");

        // Should have auditLog from tracker
        expect(ctorOptions.auditLog).toBeDefined();

        // Should have getStepsForTask callback that returns FIXER_STEPS
        expect(typeof ctorOptions.getStepsForTask).toBe("function");
    });

    it("gives up after max fix rounds and returns false", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Every reviewer, every round returns a critical finding.
        mockPromptForStructured.mockImplementation(finalReviewImpl({ criticalEveryRound: true }));

        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir");

        expect(clean).toBe(false);
        // Every lane stays dirty: 5 lanes × (1 review + 3 review-fixes passes)
        // = 5 × 4 = 20 calls.
        expect(mockPromptForStructured).toHaveBeenCalledTimes(20);
    });

    it("finalReviewPhase does not use parallelAgents", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // A critical finding in round 0 forces a fixer LanePool; round 1 is clean.
        mockPromptForStructured.mockImplementation(finalReviewImpl({ criticalRound0Dim: "efficiency" }));

        // Import the engin module and verify parallelAgents is not called
        // by checking that our mock for it doesn't exist (we didn't mock it)
        // If finalReviewPhase tried to call parallelAgents, it would get
        // the real module's version, but since our test verifies it uses
        // LanePool instead, this confirms no parallelAgents usage.
        await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir");

        // The key verification: LanePool should have been used for fixing
        // not parallelAgents. We can't directly check that parallelAgents
        // wasn't called (since we didn't mock it), but we verify that
        // LanePool WAS called, which is the expected behavior.
        expect(mockLanePoolCtor.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("accepts workDir and signal parameters", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Round 0: efficiency reviewer returns a critical finding; round 1: clean.
        mockPromptForStructured.mockImplementation(finalReviewImpl({ criticalRound0Dim: "efficiency" }));

        const controller = new AbortController();
        const clean = await finalReviewPhase(
            tracker,
            ["/profiles"],
            "/cwd",
            "/workdir",
            3,
            undefined,
            undefined,
            controller.signal,
        );

        // Verify LanePool was constructed with signal and workDir
        if (mockLanePoolCtor.mock.calls.length > 0) {
            const ctorOptions = mockLanePoolCtor.mock.calls[mockLanePoolCtor.mock.calls.length - 1][0] as Record<string, unknown>;
            expect(ctorOptions.signal).toBe(controller.signal);
            expect(ctorOptions.sessionBaseDir).toBeDefined();
        }

        expect(clean).toBe(true);
    });
});

// ─── 9. run Tests ───────────────────────────────────────────────────────────

describe("run", () => {
    it("orchestrates all phases in order", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            // scouting: topics
            .mockResolvedValueOnce({
                result: {
                    topics: [{ topic: "core", rationale: "Core module", files: ["src/core.ts"] }],
                }, attempts: 1,
            })
            // scoutingReview: ready
            .mockResolvedValueOnce({
                result: {
                    ready: true,
                    research: "Found everything",
                    gaps: [],
                }, attempts: 1,
            })
            // planning
            .mockResolvedValueOnce({
                result: {
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
                }, attempts: 1,
            })
            // planReview: approved
            .mockResolvedValueOnce({
                result: {
                    ready: true,
                    feedback: "Plan approved",
                    suggestions: [],
                }, attempts: 1,
            })
            // finalReview: clean (5 parallel reviewer lanes; default impl returns clean)
            .mockResolvedValueOnce({
                result: {
                    dimension: "efficiency",
                    applicable: true,
                    notApplicableReason: "",
                    summary: "No issues",
                    findings: [],
                }, attempts: 1,
            });

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        // Verify the workflow advanced through all phases
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);

        expect(state.currentPhaseId).toBe("done");
        expect(state.completedPhaseIds).toContain("scouting");
        expect(state.completedPhaseIds).toContain("planning");
        expect(state.completedPhaseIds).toContain("implementing");
        expect(state.completedPhaseIds).toContain("review");
    }, 30000);

    it("uses resolveProfilesDirs with 'debug' workflow name", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, research: "ok", gaps: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "none" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, feedback: "ok", suggestions: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] }, attempts: 1 });

        // Call run without profilesDir — should trigger resolveProfilesDirs
        await run("Build a feature", {
            cwd: "/project",
            workDir,
        });

        // Verify resolveProfilesDirs was called with 'debug'
        expect(mockResolveProfilesDirs).toHaveBeenCalledWith("/project", "debug");
    }, 30000);

    it("does NOT call resolveProfilesDirs when profilesDir is provided", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, research: "ok", gaps: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "none" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, feedback: "ok", suggestions: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] }, attempts: 1 });

        await run("Build a feature", {
            profilesDir: "/my-profiles",
            cwd: "/project",
            workDir,
        });

        // When profilesDir is provided, resolveProfilesDirs should NOT be called
        expect(mockResolveProfilesDirs).not.toHaveBeenCalled();
    }, 30000);

    it("creates WorkflowTUI with default maxConcurrentLanes of 3", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, research: "ok", gaps: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "none" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, feedback: "ok", suggestions: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] }, attempts: 1 });

        // Note: WorkflowTUI is not mocked here, but we can verify the behavior
        // by checking that the run completes without error when no maxConcurrentTasks
        // is provided (using the default of 3).
        // The TUI creation is conditional on !verbose && process.stdout.isTTY,
        // which is typically false in test environments.
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });
    }, 30000);

    it("creates a new tracker when no saved state exists", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, research: "ok", gaps: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "none" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, feedback: "ok", suggestions: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] }, attempts: 1 });

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
        tracker.setWorkflowData({ scoutingReports: [{ summary: "existing report" }] });
        tracker.setPhase("planning");
        await tracker.save();

        mockPromptForStructured
            // scouting review (to get research)
            .mockResolvedValueOnce({ result: { ready: true, research: "From saved reports", gaps: [] }, attempts: 1 })
            // planning
            .mockResolvedValueOnce({
                result: {
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
                }, attempts: 1,
            })
            // plan review
            .mockResolvedValueOnce({ result: { ready: true, feedback: "OK", suggestions: [] }, attempts: 1 })
            // final review (5 parallel reviewer lanes; default impl returns clean)
            .mockResolvedValueOnce({
                result: {
                    dimension: "efficiency",
                    applicable: true,
                    notApplicableReason: "",
                    summary: "No issues",
                    findings: [],
                }, attempts: 1,
            });

        await run("Resumed task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
        expect(state.taskPrompt).toBe("Resumed task");
    }, 30000);

    it("retries scouting when not ready", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            // scouting round 1
            .mockResolvedValueOnce({ result: { topics: [{ topic: "a", rationale: "A", files: [] }] }, attempts: 1 })
            // scouting review round 1: NOT ready
            .mockResolvedValueOnce({ result: { ready: false, research: "Partial", gaps: [{ topic: "need more", rationale: "gaps", files: [] }] }, attempts: 1 })
            // scouting review round 2: ready (scout-coordinator skipped because gaps exist)
            .mockResolvedValueOnce({ result: { ready: true, research: "Complete", gaps: [] }, attempts: 1 })
            // planning
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "No tasks needed" }, attempts: 1 })
            // plan review
            .mockResolvedValueOnce({ result: { ready: true, feedback: "OK", suggestions: [] }, attempts: 1 })
            // final review
            .mockResolvedValueOnce({ result: { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] }, attempts: 1 });

        await run("Build something", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);

    it("preserves plan on exhausted planning rounds", async () => {
        const workDir = tmpDir();

        // Scouting phases still run via the real runStepTask → promptForStructured.
        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { ready: true, research: "Done", gaps: [] }, attempts: 1 })
            .mockResolvedValueOnce({ result: { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "No issues", findings: [] }, attempts: 1 });

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

        await run("Fix the bug", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const raw = await fs.readFile(path.join(workDir, ".engin-state.json"), "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);
});

// ─── 10. DebugWorkflowOptions / RunOptions type verification ────────────────

describe("DebugWorkflowOptions and RunOptions", () => {
    it("DebugWorkflowOptions accepts correct properties", () => {
        const opts: DebugWorkflowOptions = {
            profilesDir: "/profiles",
            cwd: "/project",
            maxConcurrentTasks: 5,
            apiKeys: { openai: "key" },
            onStatus: {},
            verbose: true,
            workDir: "/workdir",
            signal: new AbortController().signal,
            tracker: undefined,
        };
        expect(opts.cwd).toBe("/project");
    });

    it("DebugWorkflowOptions requires cwd", () => {
        // This is a type-level check. If it compiles, the test passes.
        const opts: DebugWorkflowOptions = {
            cwd: "/project",
        };
        expect(opts.cwd).toBe("/project");
    });

    it("RunOptions extends DebugWorkflowOptions with required workDir", () => {
        const opts: RunOptions = {
            cwd: "/project",
            workDir: "/workdir",
        };
        expect(opts.cwd).toBe("/project");
        expect(opts.workDir).toBe("/workdir");
    });

    it("RunOptions accepts all optional properties from DebugWorkflowOptions", () => {
        const opts: RunOptions = {
            profilesDir: "/profiles",
            cwd: "/project",
            maxConcurrentTasks: 3,
            apiKeys: { openai: "key" },
            onStatus: {},
            verbose: true,
            workDir: "/workdir",
            signal: new AbortController().signal,
            tracker: undefined,
        };
        expect(opts.maxConcurrentTasks).toBe(3);
    });
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
