// ─── Tests for scout-coordinator profile, LanePool for fixers, remove parallelAgents ──
//
// These tests verify the 9 changes described in the task:
//   1. Remove unused parallelAgents import
//   2. makeHarnessOptions second arg is "scout-coordinator" (not "scout")
//   3. onAgentSpawn callback uses profile "scout-coordinator"
//   4. recordAgentSpawn uses profile "scout-coordinator"
//   5. onAgentComplete uses profile "scout-coordinator"
//   6. FIXER_STEPS constant defined
//   7. finalReviewPhase signature updated with workDir, maxConcurrentTasks, signal
//   8. finalReviewPhase uses LanePool (not parallelAgents) for fixers
//   9. executePhase passes new params to finalReviewPhase
//
// IMPORTANT: The scout-coordinator NOW runs via runStepTask (not createHarness).
//            The coordinator is called with profileId: "scout-coordinator".
//            runStepTask fires onTaskRegister, onTaskStart, onAgentSpawn,
//            onStepStart, onAgentComplete, onTaskComplete callbacks.
//
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile } from "@harms-haus/engin";
import type { FinalReviewTopics } from "../main";

// Capture real module before mocking so we can restore it in afterAll.
const realModule = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
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
    LanePool,
} from "@harms-haus/engin";
import {
    scoutingPhase,
    scoutingReviewPhase,
    planningPhase,
    planReviewPhase,
    implementationPhase,
    finalReviewPhase,
    run,
} from "../main";

// ─── Source code static checks ──────────────────────────────────────────────

import * as fsSync from "node:fs";

const SOURCE_PATH = path.resolve(import.meta.dir, "..", "main.ts");
const SOURCE_CODE = fsSync.readFileSync(SOURCE_PATH, "utf-8");

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const SCOUT_PROFILE: AgentProfile = {
    id: "scout-coordinator",
    name: "Scout Coordinator",
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a scout coordinator.",
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
    const base: AgentProfile = {
        id: "base",
        name: "Base",
        provider: "openai",
        model: "gpt-4",
        thinkingLevel: "medium",
        systemPrompt: "You are a helpful agent.",
        excludeTools: [],
        includeTools: [],
    };
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
        map.set(id, { ...base, id, name: id });
    }
    return map;
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `scout-coordinator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockRunStepTask.mockImplementation(async (opts: Record<string, unknown>) => {
        const taskId = opts.taskId as string;
        if (taskId === "scout-coordinator") {
            return { topics: [{ topic: "module-a", rationale: "Core module", files: ["src/a.ts"] }] };
        }
        if (taskId === "scouting-reviewer") return { ready: true, research: "Done", gaps: [] };
        if (taskId === "planner") return { tasks: [], strategy: "none" };
        if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
        if (/(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
        return {};
    });
    mockLanePoolRun.mockImplementation(async function() {
        return { completedTasks: 0, failedTasks: 0 };
    });
});

// ─── CHANGE 1: parallelAgents import removed ────────────────────────────────

describe("CHANGE 1: parallelAgents import removed", () => {
    it("source file does not contain 'import { parallelAgents }' line", () => {
        expect(SOURCE_CODE).not.toMatch(/import\s*\{\s*parallelAgents\s*\}\s*from\s*["']@harms-haus\/engin["']/);
    });

    it("source file has zero references to 'parallelAgents'", () => {
        const matches = SOURCE_CODE.match(/parallelAgents/g);
        expect(matches).toBeNull();
    });
});

// ─── CHANGE 2: scoutingPhase uses scout-coordinator via runStepTask ─────────

describe("CHANGE 2: scoutingPhase uses scout-coordinator profile via runStepTask", () => {
    it("calls runStepTask with profileId 'scout-coordinator' (not 'scout')", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockResolvedValueOnce({
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        });

        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        // Verify runStepTask was called with scout-coordinator profile
        const coordinatorCall = mockRunStepTask.mock.calls.find(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCall).toBeDefined();
        const opts = coordinatorCall![0] as Record<string, unknown>;
        // CHANGE 2: profileId should be "scout-coordinator", not "scout"
        expect(opts.profileId).toBe("scout-coordinator");
        // phaseId should be "scouting"
        expect(opts.phaseId).toBe("scouting");
        // stepName should be "coordinate"
        expect(opts.stepName).toBe("coordinate");
    });
});

// ─── CHANGE 3: onAgentSpawn callback uses profile "scout-coordinator" ───────
// Note: With runStepTask, the onAgentSpawn callback is fired by runStepTask
// internally with { agentId, profile, phaseId, taskId, stepIndex }.

describe("CHANGE 3: runStepTask called with scout-coordinator profile for onAgentSpawn", () => {
    it("runStepTask receives status callbacks for the coach-coordinator agent", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockResolvedValueOnce({
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        });

        const onAgentSpawn = mock();
        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir, undefined, { onAgentSpawn });

        // runStepTask fires onAgentSpawn internally with the correct profile.
        // Since we mock runStepTask, the callbacks won't fire from the mock.
        // Instead verify runStepTask was called with the onStatus containing onAgentSpawn
        const coordinatorCall = mockRunStepTask.mock.calls.find(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCall).toBeDefined();
        const opts = coordinatorCall![0] as Record<string, unknown>;
        expect((opts.onStatus as Record<string, unknown>).onAgentSpawn).toBe(onAgentSpawn);
    });
});

// ─── CHANGE 4: scout-coordinator profile in runStepTask opts ────────────────
// With runStepTask, the profile is passed via the profileId field.

describe("CHANGE 4: runStepTask uses profileId 'scout-coordinator'", () => {
    it("passes profileId 'scout-coordinator' to runStepTask", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockResolvedValueOnce({
            topics: [{ topic: "a", rationale: "A", files: ["a.ts"] }],
        });

        await scoutingPhase(tracker, ["/profiles"], "task", "/cwd", 3, workDir);

        const coordinatorCall = mockRunStepTask.mock.calls.find(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCall).toBeDefined();
        const opts = coordinatorCall![0] as Record<string, unknown>;
        expect(opts.profileId).toBe("scout-coordinator");
    });
});

// ─── CHANGE 5: onAgentComplete uses profile "scout-coordinator" ─────────────
// With runStepTask, onAgentComplete is fired by runStepTask internally.

describe("CHANGE 5: runStepTask receives onAgentComplete with scout-coordinator", () => {
    it("passes onStatus to runStepTask which would fire onAgentComplete", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockResolvedValueOnce({
            topics: [{ topic: "a", rationale: "A", files: ["a.ts"] }],
        });

        const onAgentComplete = mock();
        await scoutingPhase(tracker, ["/profiles"], "task", "/cwd", 3, workDir, undefined, { onAgentComplete });

        const coordinatorCall = mockRunStepTask.mock.calls.find(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCall).toBeDefined();
        const opts = coordinatorCall![0] as Record<string, unknown>;
        expect((opts.onStatus as Record<string, unknown>).onAgentComplete).toBe(onAgentComplete);
    });
});

// ─── CHANGE 6: FIXER_STEPS constant defined ─────────────────────────────────
// Now in workflowConfig.fixerSteps

describe("CHANGE 6: workflowConfig.fixerSteps defined", () => {
    it("workflowConfig.fixerSteps is defined with fixer step", () => {
        const config = (require("../main") as { workflowConfig: { fixerSteps: unknown[] } }).workflowConfig;
        expect(config.fixerSteps).toBeDefined();
        expect(Array.isArray(config.fixerSteps)).toBe(true);
        expect(config.fixerSteps.length).toBeGreaterThanOrEqual(1);
        const step = config.fixerSteps[0] as { name: string; profileId: string; isReadOnly: boolean };
        expect(step.name).toBe("fix");
        expect(step.profileId).toBe("fixer");
        expect(step.isReadOnly).toBe(false);
    });
});

// ─── CHANGE 7: finalReviewPhase signature updated ───────────────────────────

describe("CHANGE 7: finalReviewPhase signature", () => {
    it("finalReviewPhase accepts workDir, maxConcurrentTasks, signal", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const assessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Good",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: assessment, attempts: 1 });

        // Should not throw — signature accepts the new parameters
        const clean = await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", "/workdir", 3, undefined, undefined, undefined,
        );

        expect(clean).toBe(true);
    });

    it("finalReviewPhase passes fixerSteps from config", async () => {
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
            if (/(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });

        const fixerSteps = [{ name: "fix", profileId: "fixer", isReadOnly: false }];
        // finalReviewers (9th arg) is undefined → use the default 4 reviewers.
        // fixerSteps is now the 10th arg.
        await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", "/workdir", 3, undefined, undefined, undefined, undefined,
            fixerSteps,
        );

        // LanePool should have been created for fixers
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        expect(ctorOptions.getStepsForTask).toBeDefined();
    });
});

// ─── CHANGE 8: finalReviewPhase uses LanePool (not parallelAgents) for fixers ─

describe("CHANGE 8: finalReviewPhase uses LanePool for fixers", () => {
    it("creates LanePool for fixer tasks", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (typeof taskId !== "string") return {};
            // Round 0: only the efficiency reviewer reports a critical finding.
            if (taskId === "efficiency-reviewer-round-0") {
                return { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "Needs fixing", findings: [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Critical bug", description: "Why it matters", fixPrompt: "Fix it by ..." }] };
            }
            if (/(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", "/workdir", 3);

        // LanePool should have been created for fixers
        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
    });

    it("passes fixerSteps to LanePool via getStepsForTask", async () => {
        const dir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (typeof taskId !== "string") return {};
            // Round 0: only the efficiency reviewer reports a critical finding.
            if (taskId === "efficiency-reviewer-round-0") {
                return { dimension: "efficiency", applicable: true, notApplicableReason: "", summary: "Needs fixing", findings: [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Why it matters", fixPrompt: "Fix it by ..." }] };
            }
            if (/(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) {
                return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            }
            return {};
        });

        const customFixerSteps = [
            { name: "fix", profileId: "fixer", isReadOnly: false },
            { name: "verify", profileId: "implement-reviewer", isReadOnly: true },
        ];

        // finalReviewers (9th arg) is undefined → use the default 4 reviewers.
        // fixerSteps is now the 10th arg.
        await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", "/workdir", 3, undefined, undefined, undefined, undefined,
            customFixerSteps,
        );

        expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
        const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
        const getStepsForTask = ctorOptions.getStepsForTask as (task: Record<string, unknown>) => unknown[];
        const steps = getStepsForTask({});
        expect(steps).toEqual(customFixerSteps);
    });
});

// ─── CHANGE 9: executePhase passes new params to finalReviewPhase ──────────
// This is verified through the run() function integration tests.

describe("CHANGE 9: executePhase integration", () => {
    it("run() completes successfully with all new params", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation(async (opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Done", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (/(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            return {};
        });
        mockPromptForStructured.mockReset();
        mockPromptForStructured
            .mockResolvedValueOnce({ result: { title: "Test title" }, attempts: 1 })
            .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 });

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
        });

        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    }, 30000);
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
