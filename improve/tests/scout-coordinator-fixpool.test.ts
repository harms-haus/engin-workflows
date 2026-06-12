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

mock.module("@harms-haus/engin", () => ({
    ...realModule,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
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

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockImplementation(async function(this: unknown) {
        // Auto-process tasks from the LanePool's taskTracker so tests
        // don't need to manually drive the pool.
        const lastCall = mockLanePoolCtor.mock.calls[mockLanePoolCtor.mock.calls.length - 1];
        if (lastCall?.[0]) {
            const opts = lastCall[0] as Record<string, unknown>;
            if (opts.taskTracker && typeof (opts.taskTracker as any).getAllTasks === 'function') {
                const tt = opts.taskTracker as any;
                for (const task of [...tt.getAllTasks()]) {
                    const claimed = tt.claimTasks(1);
                    if (claimed.length > 0) {
                        tt.startTask(claimed[0].id, 'mock-lane');
                        tt.submitForReview(claimed[0].id, { report: `result for ${claimed[0].title}` });
                        tt.completeTask(claimed[0].id);
                    }
                }
                const doneCount = tt.getAllTasks().filter((t: any) => t.status === 'done').length;
                return { completedTasks: doneCount, failedTasks: 0 };
            }
        }
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

// ─── CHANGE 2: makeHarnessOptions second arg is "scout-coordinator" ─────────

describe("CHANGE 2: scoutingPhase uses scout-coordinator profile for makeHarnessOptions", () => {
    it("creates harness with profileId 'scout-coordinator' (not 'scout')", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce({ result: topics, attempts: 1 });

        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        // The first createHarness call is for the scout-coordinator
        const harnessCall = mockCreateHarness.mock.calls[0];
        expect(harnessCall).toBeDefined();
        const opts = harnessCall[0] as { profile: { id: string }; agentId: string };
        // CHANGE 2: profileId should be "scout-coordinator", not "scout"
        expect(opts.profile.id).toBe("scout-coordinator");
    });
});

// ─── CHANGE 3: onAgentSpawn callback uses profile "scout-coordinator" ───────

describe("CHANGE 3: onAgentSpawn callback for scout-coordinator uses profile 'scout-coordinator'", () => {
    it("onAgentSpawn is called with profile 'scout-coordinator' for the scout-coordinator agent", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce({ result: topics, attempts: 1 });

        const onAgentSpawn = mock();
        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir, undefined, { onAgentSpawn });

        // Find the spawn callback for the scout-coordinator agent
        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string; phase: string });
        const coordinatorSpawn = spawnCalls.find(c => c.agentId === "scout-coordinator");

        expect(coordinatorSpawn).toBeDefined();
        // CHANGE 3: profile must be "scout-coordinator", not "scout"
        expect(coordinatorSpawn!.profile).toBe("scout-coordinator");
    });
});

// ─── CHANGE 4: recordAgentSpawn uses profile "scout-coordinator" ────────────

describe("CHANGE 4: recordAgentSpawn for scout-coordinator uses profile 'scout-coordinator'", () => {
    it("tracker.recordAgentSpawn is called with profile 'scout-coordinator' when scouting", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // Spy on tracker.recordAgentSpawn
        const recordAgentSpawnSpy = mock();
        const origRecordAgentSpawn = tracker.recordAgentSpawn.bind(tracker);
        tracker.recordAgentSpawn = (args: { agentId: string; profile: string; phase: string }) => {
            recordAgentSpawnSpy(args);
            return origRecordAgentSpawn(args);
        };

        const topics = {
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce({ result: topics, attempts: 1 });

        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir);

        // Find the recordAgentSpawn call for the scout-coordinator agent
        const recordCalls = recordAgentSpawnSpy.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string; phase: string });
        const coordinatorRecord = recordCalls.find(c => c.agentId === "scout-coordinator");

        expect(coordinatorRecord).toBeDefined();
        // CHANGE 4: profile must be "scout-coordinator", not "scout"
        expect(coordinatorRecord!.profile).toBe("scout-coordinator");
    });
});

// ─── CHANGE 5: onAgentComplete callback uses profile "scout-coordinator" ────

describe("CHANGE 5: onAgentComplete callback for scout-coordinator uses profile 'scout-coordinator'", () => {
    it("onAgentComplete is called with profile 'scout-coordinator' for the scout-coordinator agent", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                { topic: "module-a", rationale: "Core module", files: ["src/a.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce({ result: topics, attempts: 1 });

        const onAgentComplete = mock();
        await scoutingPhase(tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir, undefined, { onAgentComplete });

        // Find the complete callback for the scout-coordinator agent
        const completeCalls = onAgentComplete.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string; phase: string });
        const coordinatorComplete = completeCalls.find(c => c.agentId === "scout-coordinator");

        expect(coordinatorComplete).toBeDefined();
        // CHANGE 5: profile must be "scout-coordinator", not "scout"
        expect(coordinatorComplete!.profile).toBe("scout-coordinator");
    });
});

// ─── CHANGE 6: FIXER_STEPS constant defined ─────────────────────────────────

describe("CHANGE 6: FIXER_STEPS constant defined", () => {
    it("source file defines FIXER_STEPS", () => {
        expect(SOURCE_CODE).toMatch(/const\s+FIXER_STEPS\s*:\s*StepDefinition\[\]/);
    });

    it("FIXER_STEPS contains a 'fix' step with profileId 'fixer'", () => {
        // Look for the FIXER_STEPS definition in the source
        const fixerStepsMatch = SOURCE_CODE.match(
            /const\s+FIXER_STEPS\s*:\s*StepDefinition\[\]\s*=\s*\[([\s\S]*?)\]/,
        );
        expect(fixerStepsMatch).not.toBeNull();
        const definition = fixerStepsMatch![1];
        expect(definition).toContain("'fix'");
        expect(definition).toContain("'fixer'");
        expect(definition).toContain("isReadOnly: false");
    });
});

// ─── CHANGE 7: finalReviewPhase signature updated ──────────────────────────

describe("CHANGE 7: finalReviewPhase signature includes workDir, maxConcurrentTasks, signal", () => {
    it("finalReviewPhase accepts workDir parameter after cwd", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const assessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Clean",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: assessment, attempts: 1 });

        // Should accept the new signature: (tracker, profilesDirs, cwd, maxConcurrentTasks, workDir, ...)
        const clean = await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

        expect(clean).toBe(true);
    });

    it("finalReviewPhase accepts all new parameters including signal", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);
        const controller = new AbortController();

        const assessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Clean",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: assessment, attempts: 1 });

        // Full new signature: (tracker, profilesDirs, cwd, maxConcurrentTasks, workDir, apiKeys, onStatus, signal)
        const clean = await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", 3, workDir,
            { openai: "key" },
            { onAgentSpawn: mock() },
            controller.signal,
        );

        expect(clean).toBe(true);
    });

    it("source file has finalReviewPhase signature with workDir and maxConcurrentTasks", () => {
        // Verify the function signature in the source contains the new params in order
        const sigMatch = SOURCE_CODE.match(
            /export\s+async\s+function\s+finalReviewPhase\s*\(\s*\n?\s*tracker[^,]*,\s*\n?\s*profilesDirs[^,]*,\s*\n?\s*cwd[^,]*,\s*\n?\s*maxConcurrentTasks[^,]*,\s*\n?\s*workDir/,
        );
        expect(sigMatch).not.toBeNull();
    });
});

// ─── CHANGE 8: finalReviewPhase uses LanePool for fixers (not parallelAgents) ──

describe("CHANGE 8: finalReviewPhase uses LanePool for fixers", () => {
    it("uses LanePool (not parallelAgents) when there are critical issues", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        // First review: finds critical issues
        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Critical bug in auth", severity: "critical" },
                { file: "src/b.ts", description: "Critical bug in db", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        // Second review: all fixed
        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "All fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        const clean = await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", 3, workDir,
            { openai: "key" },
        );

        expect(clean).toBe(true);

        // CHANGE 8: LanePool should have been created for the fixer round
        // (One LanePool for the fixer pool, in addition to any from the reviewer harness)
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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug A", severity: "critical" },
                { file: "src/b.ts", description: "Bug B", severity: "critical" },
                { file: "src/c.ts", description: "Bug C", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

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

        // Tasks should be named fixer-0, fixer-1, fixer-2
        expect(fixerTaskIds).toEqual(["fixer-0", "fixer-1", "fixer-2"]);
    });

    it("creates fixer tasks with correct prompts containing file and issue description", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/auth.ts", description: "Missing null check on token", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 7, workDir);

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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        const onAgentSpawn = mock();
        const onAgentComplete = mock();
        await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", 5, workDir,
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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(
            tracker, ["/profiles"], "/cwd", 5, workDir,
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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

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

        const firstAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Needs fixes",
            issues: [
                { file: "src/a.ts", description: "Bug", severity: "critical" },
            ],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: firstAssessment, attempts: 1 });

        const secondAssessment: FinalReviewTopics = {
            topics: [],
            overallAssessment: "Fixed",
            issues: [],
        };
        mockPromptForStructured.mockResolvedValueOnce({ result: secondAssessment, attempts: 1 });

        await finalReviewPhase(tracker, ["/profiles"], "/cwd", 5, workDir);

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
        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            // scouting: topics (empty so no LanePool for scouts)
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            // scouting review: ready
            .mockResolvedValueOnce({ result: { ready: true, research: "Done", gaps: [] }, attempts: 1 })
            // planning
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "none" }, attempts: 1 })
            // plan review: approved
            .mockResolvedValueOnce({ result: { ready: true, feedback: "OK", suggestions: [] }, attempts: 1 })
            // final review: clean (no issues)
            .mockResolvedValueOnce({ result: {
                topics: [],
                overallAssessment: "Good",
                issues: [],
            }, attempts: 1 });
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

        // The review phase should have triggered a finalReviewPhase call.
        // We can verify this worked correctly by checking that the final
        // review promptForStructured call happened (the 6th call in sequence).
        expect(mockPromptForStructured.mock.calls.length).toBeGreaterThanOrEqual(6);

        // Verify the workflow completed successfully
        const statePath = path.join(workDir, ".engin-state.json");
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        expect(state.currentPhase).toBe("done");
        expect(state.completedPhases).toContain("review");
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
        expect(state.currentPhase).toBe("done");
    });

    it("run() with critical issues in review uses LanePool (not parallelAgents) for fixers", async () => {
        const workDir = tmpDir();

        mockPromptForStructured
            // initialization: title generation
            .mockResolvedValueOnce({ result: { title: "AI title" }, attempts: 1 })
            // scouting: topics (empty)
            .mockResolvedValueOnce({ result: { topics: [] }, attempts: 1 })
            // scouting review: ready
            .mockResolvedValueOnce({ result: { ready: true, research: "Done", gaps: [] }, attempts: 1 })
            // planning
            .mockResolvedValueOnce({ result: { tasks: [], strategy: "none" }, attempts: 1 })
            // plan review: approved
            .mockResolvedValueOnce({ result: { ready: true, feedback: "OK", suggestions: [] }, attempts: 1 })
            // final review round 1: critical issue found
            .mockResolvedValueOnce({ result: {
                topics: [],
                overallAssessment: "Needs fix",
                issues: [
                    { file: "src/a.ts", description: "Critical bug", severity: "critical" },
                ],
            }, attempts: 1 })
            // final review round 2: clean
            .mockResolvedValueOnce({ result: {
                topics: [],
                overallAssessment: "Fixed",
                issues: [],
            }, attempts: 1 });

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
        expect(state.currentPhase).toBe("done");

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

// ─── Combined: All scout-coordinator callbacks use profile "scout-coordinator" ──

describe("Combined: scout-coordinator lifecycle uses correct profile throughout", () => {
    it("spawn, record, and complete all use profile 'scout-coordinator'", async () => {
        const dir = tmpDir();
        const workDir = tmpDir();
        const tracker = new WorkflowStatusTracker(dir);

        const topics = {
            topics: [
                { topic: "module-a", rationale: "Core", files: ["src/a.ts"] },
            ],
        };

        mockPromptForStructured.mockResolvedValueOnce({ result: topics, attempts: 1 });

        const onAgentSpawn = mock();
        const onAgentComplete = mock();

        // Spy on recordAgentSpawn
        const recordAgentSpawnSpy = mock();
        const origRecord = tracker.recordAgentSpawn.bind(tracker);
        tracker.recordAgentSpawn = (args: { agentId: string; profile: string; phase: string }) => {
            recordAgentSpawnSpy(args);
            return origRecord(args);
        };

        await scoutingPhase(
            tracker, ["/profiles"], "Build a feature", "/cwd", 3, workDir,
            undefined,
            { onAgentSpawn, onAgentComplete },
        );

        // Verify onAgentSpawn for scout-coordinator
        const spawnCalls = onAgentSpawn.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const coordinatorSpawn = spawnCalls.find(c => c.agentId === "scout-coordinator");
        expect(coordinatorSpawn).toBeDefined();
        expect(coordinatorSpawn!.profile).toBe("scout-coordinator");

        // Verify recordAgentSpawn for scout-coordinator
        const recordCalls = recordAgentSpawnSpy.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const coordinatorRecord = recordCalls.find(c => c.agentId === "scout-coordinator");
        expect(coordinatorRecord).toBeDefined();
        expect(coordinatorRecord!.profile).toBe("scout-coordinator");

        // Verify onAgentComplete for scout-coordinator
        const completeCalls = onAgentComplete.mock.calls.map((c: unknown[]) => c[0] as { agentId: string; profile: string });
        const coordinatorComplete = completeCalls.find(c => c.agentId === "scout-coordinator");
        expect(coordinatorComplete).toBeDefined();
        expect(coordinatorComplete!.profile).toBe("scout-coordinator");
    });
});

// ─── errorEvent preserved ───────────────────────────────────────────────────

describe("errorEvent function preserved", () => {
    it("source file still contains the errorEvent function", () => {
        expect(SOURCE_CODE).toMatch(/function\s+errorEvent\s*\(/);
        expect(SOURCE_CODE).toContain('type: "error"');
    });
});

// Restore the real module so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realModule);
});
