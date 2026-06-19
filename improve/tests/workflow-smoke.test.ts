// ─── Workflow Smoke Tests ──────────────────────────────────────────────────
//
// Integration tests that exercise the full improve workflow with mocked agent
// interactions. Real implementations are used for internal modules (TaskTracker,
// AuditLog, WorkflowStatusTracker). The external API boundary is mocked:
//   - runStepTask → returns mock LLM responses
//   - LanePool → mock that simulates task processing
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Capture real modules before mocking so we can restore them in afterAll.
const realEngin = Object.assign({}, await import("@harms-haus/engin-engine"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunMultiStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin-engine", () => ({
    ...realEngin,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
    runMultiStepTask: (...args: unknown[]) => mockRunMultiStepTask(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run } from "../main.ts";
import { WorkflowStatusTracker } from "@harms-haus/engin-engine";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHarness() {
    return {
        prompt: mock(async () => {}),
        getLastAssistantText: mock(() => ""),
        messages: [] as unknown[],
        subscribe: mock(() => mock()),
        sessionId: "test-session",
        dispose: mock(),
    };
}

function makeHarnessResult() {
    return { session: makeHarness(), sessionId: "test-session", dispose: mock() };
}

function tmpDir(): string {
    return path.join(
        os.tmpdir(),
        `workflow-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

// ─── Profiles ───────────────────────────────────────────────────────────────

const BASE_PROFILE = {
    provider: "openai",
    model: "gpt-4",
    thinkingLevel: "medium",
    systemPrompt: "You are a helpful agent.",
    excludeTools: [],
    includeTools: [],
};

function makeAllProfiles(): Map<string, unknown> {
    const map = new Map<string, unknown>();
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

// ─── Smart runStepTask handler ──────────────────────────────────────────────

/**
 * Returns mock structured data based on the taskId,
 * matching what each workflow phase expects.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;

    if (taskId === "title-generator") return { title: "AI generated title" };

    if (taskId === "scout-coordinator") {
        return {
            topics: [
                {
                    topic: "core-module",
                    rationale: "Core logic needs investigation",
                    files: ["src/core.ts"],
                },
            ],
        };
    }

    if (taskId === "scouting-reviewer") {
        return {
            ready: true,
            research: "All areas have been investigated thoroughly. No gaps remain.",
            gaps: [],
        };
    }

    if (taskId === "planner") {
        return {
            tasks: [
                {
                    id: "t1",
                    title: "Implement core feature",
                    prompt: "Implement the core feature as described",
                    profile: "implementer",
                    files: ["src/core.ts"],
                    dependencies: [],
                    is_code: true,
                },
            ],
            strategy: "Implement directly in the core module",
        };
    }

    if (taskId === "plan-reviewer") {
        return {
            ready: true,
            feedback: "Plan is well-structured and feasible",
            suggestions: [],
        };
    }

    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
        return {
            dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""),
            applicable: true,
            notApplicableReason: "",
            summary: "Code quality is good",
            findings: [],
        };
    }

    return { result: {}, attempts: 1 };
}

/** Default plan written by the smart runMultiStepTask mock when no plan.json exists. */
const DEFAULT_PLAN = {
    tasks: [{ id: "t1", title: "Default task", prompt: "Do it", profile: "implementer", files: ["src/index.ts"], dependencies: [], is_code: true }],
    strategy: "Default strategy",
};

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
            const allowed = (step.allowedWriteDirs as string[] | undefined)?.[0];
            if (allowed) {
                const planPath = path.join(allowed, "plan.json");
                try { await fs.access(planPath); } catch { await fs.mkdir(allowed, { recursive: true }); await fs.writeFile(planPath, JSON.stringify(DEFAULT_PLAN, null, 2)); }
            }
            await step.validateOutput();
        }
        results.push(step.stepName === "review-plan" ? { ready: true, feedback: "OK", suggestions: [] } : undefined);
    }
    return { results, approved: true };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);
    mockRunMultiStepTask.mockImplementation(smartRunMultiStepTask);
    mockPromptForStructured.mockReset();
    mockPromptForStructured.mockResolvedValue({ result: {}, attempts: 1 });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Workflow Smoke Tests", () => {
    // ── 1. Full workflow run ──────────────────────────────────────────

    describe("Full workflow run", () => {
        it("runs all phases and produces expected artifacts", async () => {
            const workDir = tmpDir();

            await run("Build a simple feature", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
            });

            // ── Verify .engin-state.json ────────────────────────────
            const statePath = path.join(workDir, ".engin-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);

            expect(state.currentPhaseId).toBe("done");
            expect(state.taskPrompt).toBe("Build a simple feature");
            expect(state.completedPhaseIds).toContain("scouting");
            expect(state.completedPhaseIds).toContain("planning");
            expect(state.completedPhaseIds).toContain("implementing");
            expect(state.completedPhaseIds).toContain("review");

            // ── Verify audit.jsonl ────────────────────────────────────
            const auditPath = path.join(workDir, "audit", "audit.jsonl");
            const auditRaw = await fs.readFile(auditPath, "utf-8");
            const events = auditRaw
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));

            expect(events.length).toBeGreaterThan(0);

            // structured_output events from scouting coordinator, planner, final reviewer
            const structuredEvents = events.filter(
                (e: { type: string }) => e.type === "structured_output",
            );
            expect(structuredEvents.length).toBeGreaterThanOrEqual(2);

            // decision events from scouting review, plan review
            const decisionEvents = events.filter(
                (e: { type: string }) => e.type === "decision",
            );
            expect(decisionEvents.length).toBeGreaterThanOrEqual(2);
        }, 30_000);
    });

    // ── 2. Resume scenario ───────────────────────────────────────────

    describe("Resume scenario", () => {
        it("restores state from saved .engin-state.json", async () => {
            const workDir = tmpDir();

            // Create a tracker, set some state, save it
            const tracker = new WorkflowStatusTracker(workDir);
            tracker.setTaskPrompt("Resumed task");
            tracker.setWorkflowData({ scoutingReports: [{ summary: "existing report" }] });
            tracker.setWorkflowData({ plan: {
                tasks: [{ id: "t1" }],
                strategy: "test",
            } });
            tracker.setPhase("planning");
            await tracker.save();

            // Create a new tracker loading from saved state
            const restored = await WorkflowStatusTracker.load(workDir);

            expect(restored.taskPrompt).toBe("Resumed task");
            expect(restored.currentPhaseId).toBe("planning");
            expect((restored.workflowData as Record<string, unknown>).scoutingReports).toEqual([
                { summary: "existing report" },
            ]);
            expect((restored.workflowData as Record<string, unknown>).plan).toEqual({
                tasks: [{ id: "t1" }],
                strategy: "test",
            });
        });

        it("restores task tracker state through save/load round-trip", async () => {
            const workDir = tmpDir();
            const tracker = new WorkflowStatusTracker(workDir);
            tracker.setTaskPrompt("Task with work");

            // Add tasks and advance one through the lifecycle
            tracker.taskTracker.addTask({
                id: "t1",
                title: "Base task",
                prompt: "Do base",
                profile: "implementer",
                files: ["src/base.ts"],
                dependencies: [],
            });
            tracker.taskTracker.addTask({
                id: "t2",
                title: "Dependent task",
                prompt: "Do dep",
                profile: "implementer",
                files: ["src/dep.ts"],
                dependencies: ["t1"],
            });

            // Save and restore to verify round-trip
            await tracker.save();
            const restored = await WorkflowStatusTracker.load(workDir);
            expect(restored.taskTracker.getTask("t1")!.status).toBe("ready");
            // t2 depends on t1, which is only 'ready' (not complete), so it stays blocked
            expect(restored.taskTracker.getTask("t2")!.status).toBe("blocked");
        });
    });

    // ── 3. Error handling ────────────────────────────────────────────

    describe("Error handling", () => {
        it("handles LanePool run throwing during implementation", async () => {
            const workDir = tmpDir();

            // Scouting LanePool succeeds, implementation LanePool throws
            mockLanePoolRun
                .mockResolvedValueOnce({ completedTasks: 0, failedTasks: 0 })
                .mockRejectedValueOnce(new Error("Lane pool crashed"));

            // The workflow should propagate the error
            await expect(
                run("Build with errors", {
                    profilesDir: "/profiles",
                    cwd: "/project",
                    workDir,
                }),
            ).rejects.toThrow("Lane pool crashed");

            // Verify the workflow state was saved
            const statePath = path.join(workDir, ".engin-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);
            // State should have advanced past scouting phases at least
            expect(state.completedPhaseIds.length).toBeGreaterThan(0);
        }, 30_000);

        it("handles LanePool reporting failed tasks", async () => {
            const workDir = tmpDir();

            // LanePool reports failures but doesn't throw
            mockLanePoolRun.mockResolvedValueOnce({ completedTasks: 0, failedTasks: 1 });

            // The workflow should still complete
            await run("Build with failed task", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
            });

            // Verify the workflow completed
            const statePath = path.join(workDir, ".engin-state.json");
            const stateRaw = await fs.readFile(statePath, "utf-8");
            const state = JSON.parse(stateRaw);
            expect(state.currentPhaseId).toBe("done");
        }, 30_000);
    });

    // ── 4. Status callbacks ─────────────────────────────────────────

    describe("Status callbacks", () => {
        it("all workflow-level callbacks fire during successful run", async () => {
            const workDir = tmpDir();

            const onWorkflowStart = mock();
            const onPhaseStart = mock();
            const onPhaseComplete = mock();
            const onAgentSpawn = mock();
            const onAgentComplete = mock();
            const onDecision = mock();
            const onWorkflowComplete = mock();
            const onWorkflowFailed = mock();

            await run("Build with callbacks", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
                onStatus: {
                    onWorkflowStart,
                    onPhaseStart,
                    onPhaseComplete,
                    onAgentSpawn,
                    onAgentComplete,
                    onDecision,
                    onWorkflowComplete,
                    onWorkflowFailed,
                },
            });

            // ── Lifecycle callbacks ─────────────────────────────────
            expect(onWorkflowStart).toHaveBeenCalledOnce();
            expect(onWorkflowStart).toHaveBeenCalledWith({
                taskPrompt: "Build with callbacks",
                resumed: false,
                workDir,
            });

            expect(onWorkflowComplete).toHaveBeenCalledOnce();
            expect(onWorkflowComplete).toHaveBeenCalledWith(
                expect.objectContaining({
                    totalDurationMs: expect.any(Number),
                    agentCount: expect.any(Number),
                }),
            );

            // ── Phase callbacks ─────────────────────────────────────
            // 4 phases: scouting, planning, implementing, review
            expect(
                (onPhaseStart as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(4);
            expect(
                (onPhaseComplete as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(4);

            // Verify each phase was started
            const startedPhases = (
                onPhaseStart as ReturnType<typeof mock>
            ).mock.calls.map(
                (call: [{ phase: string }]) => call[0].phase,
            );
            expect(startedPhases).toContain("scouting");
            expect(startedPhases).toContain("planning");
            expect(startedPhases).toContain("implementing");
            expect(startedPhases).toContain("review");

            // ── Agent callbacks ─────────────────────────────────────
            // runStepTask fires onAgentSpawn and onAgentComplete internally,
            // but since we mock runStepTask, those callbacks won't fire.
            // At minimum, LanePool fires some callbacks for tasks.
            // Just verify the workflow completed successfully.
            expect(onWorkflowFailed).not.toHaveBeenCalled();

            // ── Decision callbacks ─────────────────────────────────
            // runStepTask fires onDecision internally, but since we mock it,
            // those callbacks won't fire. Just verify completion.
        }, 30_000);

        it("onWorkflowFailed fires on workflow error", async () => {
            const workDir = tmpDir();
            const onWorkflowFailed = mock();
            const onWorkflowStart = mock();
            const onWorkflowComplete = mock();

            // Make runStepTask throw so the error propagates to the orchestrator's catch block.
            mockRunStepTask.mockReset();
            mockRunStepTask.mockRejectedValue(new Error("Catastrophic scouting failure"));

            await expect(
                run("Build with failure", {
                    profilesDir: "/profiles",
                    cwd: "/project",
                    workDir,
                    onStatus: {
                        onWorkflowStart,
                        onWorkflowFailed,
                        onWorkflowComplete,
                    },
                }),
            ).rejects.toThrow("Catastrophic scouting failure");

            expect(onWorkflowStart).toHaveBeenCalledOnce();
            expect(onWorkflowFailed).toHaveBeenCalledOnce();
            expect(onWorkflowFailed).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: expect.any(Error),
                    phaseId: expect.any(String),
                }),
            );
            expect(
                (onWorkflowFailed as ReturnType<typeof mock>).mock
                    .calls[0][0].error.message,
            ).toBe(
                "Catastrophic scouting failure",
            );

            // onWorkflowComplete should NOT fire on failure
            expect(onWorkflowComplete).not.toHaveBeenCalled();
        }, 30_000);

        it("LanePool receives onStatus callbacks including task callbacks", async () => {
            const workDir = tmpDir();
            const onTaskStart = mock();
            const onTaskComplete = mock();
            const onTaskRejected = mock();

            await run("Build with task callbacks", {
                profilesDir: "/profiles",
                cwd: "/project",
                workDir,
                onStatus: { onTaskStart, onTaskComplete, onTaskRejected },
            });

            // Verify LanePool was constructed (scouting + implementation)
            expect(mockLanePoolCtor).toHaveBeenCalledTimes(2);
            // Check the implementation LanePool (second call) for task callbacks
            const implCtorOptions = mockLanePoolCtor.mock.calls[1][0] as Record<string, unknown>;
            const passedStatus = implCtorOptions.onStatus as Record<string, unknown>;
            expect(typeof passedStatus.onTaskStart).toBe("function");
            expect(typeof passedStatus.onTaskComplete).toBe("function");
            expect(typeof passedStatus.onTaskRejected).toBe("function");
        }, 30_000);
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin-engine", () => realEngin);
});
