// ─── Workflow Smoke Tests ──────────────────────────────────────────────────
//
// Integration tests that exercise the full develop workflow with mocked agent
// interactions. Real implementations are used for internal modules (TaskTracker,
// AuditLog, WorkflowStatusTracker). The external API boundary is mocked:
//   - createHarness → returns mock sessions
//   - promptForStructured → parses mock LLM responses
//   - parallelAgents → returns mock results
//   - LanePool → mock that simulates task processing
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Capture real modules before mocking so we can restore them in afterAll.
const realEngin = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockParallelAgents = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realEngin,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    parallelAgents: (...args: unknown[]) => mockParallelAgents(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));;

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { run } from "../main.ts";
import { WorkflowStatusTracker } from "@harms-haus/engin";

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

// ─── Smart prompt handler ──────────────────────────────────────────────────

/**
 * Returns mock structured data based on the prompt text,
 * matching what each workflow phase expects.
 */
function defaultPromptHandler(_text: string): unknown {
    // Scouting coordinator: identify topics
    if (_text.includes("codebase scout") || _text.includes("Identify key areas")) {
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

    // Scouting review
    if (_text.includes("reviewing scouting reports")) {
        return {
            ready: true,
            research: "All areas have been investigated thoroughly. No gaps remain.",
            gaps: [],
        };
    }

    // Planning
    if (_text.includes("planning agent")) {
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

    // Plan review
    if (_text.includes("reviewing an implementation plan")) {
        return {
            ready: true,
            feedback: "Plan is well-structured and feasible",
            suggestions: [],
        };
    }

    // Final quality review
    if (_text.includes("final quality review")) {
        return {
            topics: [{ topic: "overall quality", files: ["src/core.ts"] }],
            overallAssessment: "Code quality is good",
            issues: [],
        };
    }

    // Default
    return {};
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockPromptForStructured.mockImplementation(async (_harness: unknown, text: string) => {
        return defaultPromptHandler(text);
    });
    mockParallelAgents.mockResolvedValue([]);
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

            expect(state.currentPhase).toBe("done");
            expect(state.taskPrompt).toBe("Build a simple feature");
            expect(state.completedPhases).toContain("scouting");
            expect(state.completedPhases).toContain("scouting_review");
            expect(state.completedPhases).toContain("planning");
            expect(state.completedPhases).toContain("plan_review");
            expect(state.completedPhases).toContain("implementing");
            expect(state.completedPhases).toContain("final_review");

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
            tracker.setScoutingReports([{ summary: "existing report" }]);
            tracker.setPlan({
                tasks: [{ id: "t1" }],
                strategy: "test",
            });
            tracker.setPhase("planning");
            await tracker.save();

            // Create a new tracker loading from saved state
            const restored = await WorkflowStatusTracker.load(workDir);

            expect(restored.taskPrompt).toBe("Resumed task");
            expect(restored.currentPhase).toBe("planning");
            expect(restored.scoutingReports).toEqual([
                { summary: "existing report" },
            ]);
            expect(restored.plan).toEqual({
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

            // Complete t1
            const claimed = tracker.taskTracker.claimTasks(1);
            expect(claimed).toHaveLength(1);
            tracker.taskTracker.startTask("t1", "agent-1");
            tracker.taskTracker.submitForReview("t1", { done: true });
            tracker.taskTracker.completeTask("t1");

            await tracker.save();

            // Restore and verify
            const restored = await WorkflowStatusTracker.load(workDir);
            expect(restored.taskTracker.getTask("t1")!.status).toBe("done");
            expect(restored.taskTracker.getTask("t2")!.status).toBe("ready");
        });
    });

    // ── 3. Error handling ────────────────────────────────────────────

    describe("Error handling", () => {
        it("handles LanePool run throwing during implementation", async () => {
            const workDir = tmpDir();

            // Make LanePool throw
            mockLanePoolRun.mockRejectedValueOnce(new Error("Lane pool crashed"));

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
            expect(state.completedPhases.length).toBeGreaterThan(0);
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
            expect(state.currentPhase).toBe("done");
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
            // 6 phases: scouting, scouting_review, planning, plan_review,
            // implementing, final_review
            expect(
                (onPhaseStart as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(6);
            expect(
                (onPhaseComplete as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(6);

            // Verify each phase was started
            const startedPhases = (
                onPhaseStart as ReturnType<typeof mock>
            ).mock.calls.map(
                (call: [{ phase: string }]) => call[0].phase,
            );
            expect(startedPhases).toContain("scouting");
            expect(startedPhases).toContain("scouting_review");
            expect(startedPhases).toContain("planning");
            expect(startedPhases).toContain("plan_review");
            expect(startedPhases).toContain("implementing");
            expect(startedPhases).toContain("final_review");

            // ── Agent callbacks ─────────────────────────────────────
            // At minimum: scout-coordinator, planner, final-reviewer
            expect(
                (onAgentSpawn as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(3);
            expect(
                (onAgentComplete as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(3);

            // ── Decision callbacks ─────────────────────────────────
            // At minimum: scouting-reviewer, plan-reviewer
            expect(
                (onDecision as ReturnType<typeof mock>).mock.calls.length,
            ).toBeGreaterThanOrEqual(2);

            // ── Error should not have been called ───────────────────
            expect(onWorkflowFailed).not.toHaveBeenCalled();
        }, 30_000);

        it("onWorkflowFailed fires on workflow error", async () => {
            const workDir = tmpDir();
            const onWorkflowFailed = mock();
            const onWorkflowStart = mock();
            const onWorkflowComplete = mock();

            // Make the scouting phase throw so the error propagates
            // to the orchestrator's catch block.
            mockPromptForStructured.mockImplementation(async () => {
                throw new Error("Catastrophic scouting failure");
            });

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
                    phase: expect.any(String),
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

            // Verify LanePool was constructed with onStatus containing task callbacks
            expect(mockLanePoolCtor).toHaveBeenCalledTimes(1);
            const ctorOptions = mockLanePoolCtor.mock.calls[0][0] as Record<string, unknown>;
            const passedStatus = ctorOptions.onStatus as Record<string, unknown>;
            expect(typeof passedStatus.onTaskStart).toBe("function");
            expect(typeof passedStatus.onTaskComplete).toBe("function");
            expect(typeof passedStatus.onTaskRejected).toBe("function");
        }, 30_000);
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
