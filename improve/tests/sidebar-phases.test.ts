// ─── Sidebar Phases Tests ──────────────────────────────────────────────────
//
// Tests that verify the SIDEBAR_PHASES array contains the correct entries,
// with the initialization phase as the first element. Since SIDEBAR_PHASES
// and getPhaseIndicator are not exported, we test them indirectly through
// the onSidebarUpdate callback in run().
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

// Capture real modules before mocking so we can restore them in afterAll.
const realEngin = Object.assign({}, await import("@harms-haus/engin"));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateHarness = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockPromptForStructured = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLoadProfilesFromDirs = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolRun = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockLanePoolCtor = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);
const mockRunStepTask = mock() as ReturnType<typeof mock> & ((...args: unknown[]) => unknown);

mock.module("@harms-haus/engin", () => ({
    ...realEngin,
    createHarness: (...args: unknown[]) => mockCreateHarness(...args),
    promptForStructured: (...args: unknown[]) => mockPromptForStructured(...args),
    loadProfilesFromDirs: (...args: unknown[]) => mockLoadProfilesFromDirs(...args),
    runStepTask: (...args: unknown[]) => mockRunStepTask(...args),
    LanePool: function(this: { run: unknown }, ...args: unknown[]) {
        mockLanePoolCtor(...args);
        this.run = mockLanePoolRun;
    },
}));

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
        `sidebar-phases-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
}

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

/**
 * Smart mock for runStepTask based on taskId.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const taskId = opts.taskId as string;
    if (taskId === "title-generator") return { title: "AI generated title" };
    if (taskId === "scout-coordinator") return { topics: [] };
    if (taskId === "scouting-reviewer") return { ready: true, research: "All scouted", gaps: [] };
    if (taskId === "planner") return { tasks: [], strategy: "none" };
    if (taskId === "plan-reviewer") return { ready: true, feedback: "OK", suggestions: [] };
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security)-reviewer-round-\d+$/.test(taskId)) return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
    return {};
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
    mock.clearAllMocks();
    mockLoadProfilesFromDirs.mockResolvedValue(makeAllProfiles());
    mockCreateHarness.mockResolvedValue(makeHarnessResult());
    mockLanePoolRun.mockResolvedValue({ completedTasks: 0, failedTasks: 0 });
    mockRunStepTask.mockImplementation(smartRunStepTask);
    mockPromptForStructured.mockReset();
    mockPromptForStructured.mockResolvedValue({ result: {}, attempts: 1 });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("onSidebarUpdate — no phases field", () => {
    it("onSidebarUpdate does NOT carry phases", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // Phase metadata is now sent via onPhaseRegister, not onSidebarUpdate
        const hasPhases = onSidebarUpdate.mock.calls.some(
            (call: unknown[]) => (call[0] as Record<string, unknown>).phases !== undefined
        );
        expect(hasPhases).toBe(false);
    });

    it("onSidebarUpdate carries title and indicator only", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        expect(onSidebarUpdate).toHaveBeenCalled();

        for (const call of onSidebarUpdate.mock.calls) {
            const data = call[0] as Record<string, unknown>;
            const keys = Object.keys(data);
            // Only title and indicator are allowed
            for (const key of keys) {
                expect(key === "title" || key === "indicator").toBe(true);
            }
        }
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
