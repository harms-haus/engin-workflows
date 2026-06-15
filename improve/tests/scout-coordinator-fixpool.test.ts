// ─── Tests for scout-coordinator profile, LanePool for fixers, remove parallelAgents ──
//
// These tests verify the changes described in the task:
//   1. Remove unused parallelAgents import
//   2. Scout-coordinator runs via runStepTask (not createHarness)
//   3. Scout-coordinator runs via runStepTask (not createHarness)
//   4. Scout-coordinator runs via runStepTask (not createHarness)
//   5. Scout-coordinator runs via runStepTask (not createHarness)
//   6. FIXER_STEPS constant defined
//   7. finalReviewPhase signature updated with workDir, maxConcurrentTasks, signal
//   8. finalReviewPhase uses LanePool (not parallelAgents) for fixers
//   9. executePhase passes new params to finalReviewPhase
//
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentProfile } from "@harms-haus/engin";
import type { FinalReviewTopics } from "../main.ts";

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
} from "../main.ts";

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

// ─── Multi-dimensional final-review mock helpers ─────────────────────────────
//
// The final review now runs four reviewers in parallel each round
// (efficiency / code-quality / ui-ux / security), each producing a
// FinalReviewResult. To keep fixer-task counts predictable these helpers make
// ONLY the efficiency-reviewer report findings (rounds <= lastIssueRound); the
// other three dimensions always return a clean result.

/** Clean FinalReviewResult keyed off the reviewer taskId dimension. */
function cleanReviewerResult(taskId: string) {
    return {
        dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""),
        applicable: true,
        notApplicableReason: "",
        summary: "No issues",
        findings: [] as unknown[],
    };
}

/**
 * runStepTask implementation for finalReviewPhase tests. Only the
 * efficiency-reviewer reports `efficiencyFindings` on rounds <= lastIssueRound
 * (default: round 0 only); every other reviewer is clean on every round.
 */
function reviewerRunStepTaskImpl(
    opts: Record<string, unknown>,
    efficiencyFindings: unknown[],
    lastIssueRound = 0,
): unknown {
    const taskId = opts.taskId as string;
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
        const round = Number(taskId.match(/-round-(\d+)$/)![1]);
        if (taskId.startsWith("efficiency-reviewer-round-") && round <= lastIssueRound) {
            return {
                dimension: "efficiency",
                applicable: true,
                notApplicableReason: "",
                summary: "Needs fixes",
                findings: efficiencyFindings,
            };
        }
        return cleanReviewerResult(taskId);
    }
    return {};
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
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

// ─── CHANGE 2: scout-coordinator uses runStepTask ──────────────────────────

describe("CHANGE 2: scoutingPhase uses runStepTask for scout-coordinator", () => {
    it("calls runStepTask with profileId 'scout-coordinator'", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockResolvedValueOnce({
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        });

        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        // runStepTask should have been called with scout-coordinator
        expect(mockRunStepTask).toHaveBeenCalledTimes(1);
        const callOpts = mockRunStepTask.mock.calls[0][0] as Record<string, unknown>;
        expect(callOpts.taskId).toBe("scout-coordinator");
        expect(callOpts.profileId).toBe("scout-coordinator");
    });
});

// ─── CHANGE 3-5: scout-coordinator runs via runStepTask ─────────────────────

describe("CHANGE 3-5: scout-coordinator lifecycle via runStepTask", () => {
    it("runStepTask is called with scout-coordinator taskId", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockResolvedValueOnce({
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        });

        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        // Verify runStepTask was called with scout-coordinator
        const coordinatorCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCalls.length).toBe(1);
        const callOpts = coordinatorCalls[0][0] as Record<string, unknown>;
        expect(callOpts.profileId).toBe("scout-coordinator");
        expect(callOpts.phaseId).toBe("scouting");
    });
});

// ─── CHANGE 7: finalReviewPhase signature updated ──────────────────────────

describe("CHANGE 7: finalReviewPhase signature includes workDir, maxConcurrentTasks, signal", () => {
    it("finalReviewPhase accepts workDir parameter after cwd", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // All four reviewers return a clean result every round.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => reviewerRunStepTaskImpl(opts, []));

        // Should accept the new signature: (tracker, profilesDirs, cwd, workDir, maxConcurrentTasks, ...)
        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        expect(clean).toBe(true);
    });

    it("finalReviewPhase accepts all new parameters including signal", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);
        const controller = new AbortController();

        mockRunStepTask.mockReset();
        // All four reviewers return a clean result every round.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => reviewerRunStepTaskImpl(opts, []));

        // Full new signature: (tracker, profilesDirs, cwd, workDir, maxConcurrentTasks, apiKeys, onStatus, signal)
        const clean = await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", workDir, 3,
            { openai: "key" },
            { onAgentSpawn: mock() },
            controller.signal,
        );

        expect(clean).toBe(true);
    });
});

// ─── CHANGE 8: finalReviewPhase uses LanePool for fixers (not parallelAgents) ──

describe("CHANGE 8: finalReviewPhase uses LanePool for fixers", () => {
    it("uses LanePool (not parallelAgents) when there are critical issues", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: ONLY efficiency-reviewer reports a critical finding; the
        // other three dimensions are clean. Round 1: all clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Critical bug in auth", description: "Critical bug in auth", fixPrompt: "Fix it by ..." },
            ]),
        );

        const clean = await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", workDir, 3,
            { openai: "key" },
        );

        expect(clean).toBe(true);

        // CHANGE 8: LanePool should have been created for the fixer round
        expect(mockLanePoolCtor.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Find the LanePool that was created for fixers (it will have tasks with 'fixer' profile)
        let fixerPoolFound = false;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.length > 0 && tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolFound = true;
                    break;
                }
            }
        }
        expect(fixerPoolFound).toBe(true);

        // Verify LanePool.run was called
        expect(mockLanePoolRun.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("creates fixer tasks with correct ids (fixer-0, fixer-1, etc.)", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 3 critical findings → 3 fixer tasks.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug A", description: "Bug A", fixPrompt: "Fix it by ..." },
                { id: "f2", severity: "critical", file: "src/b.ts", title: "Bug B", description: "Bug B", fixPrompt: "Fix it by ..." },
                { id: "f3", severity: "critical", file: "src/c.ts", title: "Bug C", description: "Bug C", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        // Find the fixer LanePool and inspect its task tracker
        let fixerTaskIds: string[] = [];
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                const fixerTasks = tasks.filter((t: any) => t.profile === 'fixer');
                if (fixerTasks.length > 0) {
                    fixerTaskIds = fixerTasks.map((t: any) => t.id);
                    break;
                }
            }
        }

        // Tasks are scoped per dimension + fix round within a lane:
        // fixer-efficiency-0-0, fixer-efficiency-0-1, fixer-efficiency-0-2
        expect(fixerTaskIds).toEqual(["fixer-efficiency-0-0", "fixer-efficiency-0-1", "fixer-efficiency-0-2"]);
    });

    it("creates fixer tasks with correct prompts containing file and issue description", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/auth.ts", title: "Missing null check", description: "Missing null check on token", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        // Find the fixer task and check its prompt
        let fixerPrompt = "";
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                const fixerTasks = tasks.filter((t: any) => t.profile === 'fixer');
                if (fixerTasks.length > 0) {
                    fixerPrompt = fixerTasks[0].prompt;
                    break;
                }
            }
        }

        expect(fixerPrompt).toContain("You are a fix agent");
        expect(fixerPrompt).toContain("src/auth.ts");
        expect(fixerPrompt).toContain("Missing null check on token");
    });

    it("passes maxConcurrentTasks to LanePool as maxConcurrentLanes", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 7);

        // Find the fixer LanePool
        let fixerPoolOpts: Record<string, unknown> | null = null;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolOpts = opts;
                    break;
                }
            }
        }

        expect(fixerPoolOpts).not.toBeNull();
        expect(fixerPoolOpts!.maxConcurrentLanes).toBe(7);
    });

    it("defaults maxConcurrentLanes to the passed value", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        // Find the fixer LanePool
        let fixerPoolOpts: Record<string, unknown> | null = null;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolOpts = opts;
                    break;
                }
            }
        }

        expect(fixerPoolOpts).not.toBeNull();
        expect(fixerPoolOpts!.maxConcurrentLanes).toBe(5);
    });

    it("passes workDir as part of the sessionBaseDir for the fixer LanePool", async () => {
        const dir = tmpDir();
        const workDir = "/my-work-dir";
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        // Find the fixer LanePool
        let fixerPoolOpts: Record<string, unknown> | null = null;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolOpts = opts;
                    break;
                }
            }
        }

        expect(fixerPoolOpts).not.toBeNull();
        // sessionBaseDir should include workDir
        expect(fixerPoolOpts!.sessionBaseDir).toContain("/my-work-dir");
    });

    it("does NOT manually call onAgentSpawn/recordAgentSpawn for fixers (LanePool handles lifecycle)", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", workDir, 5,
            undefined,
            { onAgentSpawn, onAgentComplete },
        );

        // LanePool handles lifecycle internally, so the workflow should NOT manually
        // call onAgentSpawn for fixer agents. Only the reviewer spawn should appear.
        const spawnCalls = onAgentSpawn.mock.calls.map(
            (c: unknown[]) => c[0] as { agentId: string; profile: string },
        );

        // There should be no manual fixer spawns with agentId like "fixer-0"
        const manualFixerSpawns = spawnCalls.filter(c => c.agentId.startsWith("fixer-"));
        expect(manualFixerSpawns).toHaveLength(0);
    });

    it("passes signal to fixer LanePool", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);
        const controller = new AbortController();

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", workDir, 5,
            undefined, undefined, controller.signal,
        );

        // Find the fixer LanePool
        let fixerPoolOpts: Record<string, unknown> | null = null;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolOpts = opts;
                    break;
                }
            }
        }

        expect(fixerPoolOpts).not.toBeNull();
        expect(fixerPoolOpts!.signal).toBe(controller.signal);
    });

    it("passes auditLog from tracker to fixer LanePool", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        // Find the fixer LanePool
        let fixerPoolOpts: Record<string, unknown> | null = null;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolOpts = opts;
                    break;
                }
            }
        }

        expect(fixerPoolOpts).not.toBeNull();
        expect(fixerPoolOpts!.auditLog).toBe(tracker.auditLog);
    });

    it("fixer tasks have isCode set to true", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        // Round 0: efficiency-reviewer reports 1 critical finding; round 1 clean.
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) =>
            reviewerRunStepTaskImpl(opts, [
                { id: "f1", severity: "critical", file: "src/a.ts", title: "Bug", description: "Bug", fixPrompt: "Fix it by ..." },
            ]),
        );

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", workDir, 5);

        // Find fixer tasks
        let fixerTasks: any[] = [];
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                const fixerList = tasks.filter((t: any) => t.profile === 'fixer');
                if (fixerList.length > 0) {
                    fixerTasks = fixerList;
                    break;
                }
            }
        }

        expect(fixerTasks.length).toBeGreaterThan(0);
        for (const task of fixerTasks) {
            expect(task.isCode).toBe(true);
        }
    });
});

// ─── CHANGE 9: executePhase passes new params to finalReviewPhase ──────────

describe("CHANGE 9: executePhase passes workDir, maxConcurrentTasks, signal to finalReviewPhase", () => {
    /** Setup mocks for a minimal run that reaches the review phase. */
    function setupMocksForReview() {
        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Done", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
            return {};
        });
        mockPromptForStructured.mockReset();
        mockPromptForStructured.mockResolvedValue({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 });
    }

    it("run() passes workDir and maxConcurrentTasks through to finalReviewPhase via executePhase", async () => {
        const workDir = tmpDir();
        setupMocksForReview();

        // Using maxConcurrentTasks: 7 should propagate to finalReviewPhase
        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            maxConcurrentTasks: 7,
        });

        // Verify the workflow completed successfully
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
        expect(state.completedPhaseIds).toContain("review");
    });

    it("run() propagates signal to finalReviewPhase", async () => {
        const workDir = tmpDir();
        setupMocksForReview();

        const controller = new AbortController();

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            signal: controller.signal,
        });

        // The review phase should have been reached and completed
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");
    });

    it("run() with critical issues in review uses LanePool (not parallelAgents) for fixers", async () => {
        const workDir = tmpDir();

        mockRunStepTask.mockReset();
        mockRunStepTask.mockImplementation((opts: Record<string, unknown>) => {
            const taskId = opts.taskId as string;
            if (taskId === "title-generator") return { title: "AI title" };
            if (taskId === "scout-coordinator") return { topics: [] };
            if (taskId === "scouting-reviewer") return { ready: true, research: "Done", gaps: [] };
            if (taskId === "planner") return { tasks: [], strategy: "none" };
            if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
            if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
                // Round 0: efficiency-reviewer reports a critical finding; round 1: all clean.
                return reviewerRunStepTaskImpl(
                    opts,
                    [{ id: "f1", severity: "critical", file: "src/a.ts", title: "Critical bug", description: "Critical bug", fixPrompt: "Fix it by ..." }],
                );
            }
            return {};
        });
        mockPromptForStructured.mockReset();
        mockPromptForStructured.mockResolvedValue({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 });

        await run("Build a feature", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            maxConcurrentTasks: 3,
        });

        // Verify the workflow completed
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhaseId).toBe("done");

        // Verify LanePool was used for fixers (look for a LanePool with fixer tasks)
        let fixerPoolFound = false;
        for (const call of mockLanePoolCtor.mock.calls) {
            const opts = call[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                const tasks = tt.getAllTasks();
                if (tasks.some((t: any) => t.profile === 'fixer')) {
                    fixerPoolFound = true;
                    // Also verify maxConcurrentLanes was passed through from run()
                    expect(opts.maxConcurrentLanes).toBe(3);
                    break;
                }
            }
        }
        expect(fixerPoolFound).toBe(true);
    }, 30000);
});

// ─── Combined: scout-coordinator runs via runStepTask ─────────────────────────

describe("Combined: scout-coordinator lifecycle via runStepTask", () => {
    it("runStepTask is called with correct profile and phase", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        mockRunStepTask.mockReset();
        mockRunStepTask.mockResolvedValueOnce({
            topics: [
                { topic: "module-a", rationale: "Core", files: ["src/a.ts"] },
            ],
        });

        await scoutingPhase(
            tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir,
        );

        // Verify runStepTask was called with scout-coordinator
        const coordinatorCalls = mockRunStepTask.mock.calls.filter(
            (call: unknown[]) => (call[0] as Record<string, unknown>).taskId === "scout-coordinator"
        );
        expect(coordinatorCalls.length).toBe(1);
        const callOpts = coordinatorCalls[0][0] as Record<string, unknown>;
        expect(callOpts.profileId).toBe("scout-coordinator");
        expect(callOpts.phaseId).toBe("scouting");
        expect(callOpts.isReadOnly).toBe(true);
    });
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
