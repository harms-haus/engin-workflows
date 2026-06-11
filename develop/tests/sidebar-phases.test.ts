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

/** Default mock prompt handler for a successful run. */
function defaultPromptHandler(_text: string): unknown {
    if (_text.includes("codebase scout") || _text.includes("Identify key areas")) {
        return { topics: [] };
    }
    if (_text.includes("reviewing scouting reports")) {
        return { ready: true, research: "All scouted", gaps: [] };
    }
    if (_text.includes("planning agent")) {
        return { tasks: [], strategy: "none" };
    }
    if (_text.includes("reviewing an implementation plan")) {
        return { ready: true, feedback: "OK", suggestions: [] };
    }
    if (_text.includes("final quality review")) {
        return { topics: [], overallAssessment: "Good", issues: [] };
    }
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

describe("SIDEBAR_PHASES", () => {
    it("contains initialization as the first phase entry", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // onSidebarUpdate should have been called at least once with the phases array
        expect(onSidebarUpdate).toHaveBeenCalled();

        // Find the call that includes the full phases array
        const sidebarCalls = onSidebarUpdate.mock.calls
            .map((call: unknown[]) => call[0] as Record<string, unknown>)
            .filter((data: Record<string, unknown>) => data.phases !== undefined);

        expect(sidebarCalls.length).toBeGreaterThanOrEqual(1);

        const sidebarData = sidebarCalls[0];
        const phases = sidebarData.phases as Array<{ id: string; label: string; icon: string }>;

        // Should have 7 entries (initialization + 6 existing)
        expect(phases).toHaveLength(7);

        // First entry must be initialization
        expect(phases[0].id).toBe("initialization");
        expect(phases[0].label).toBe("Initialization");
        expect(phases[0].icon).toBe("⚙");

        // Subsequent entries should match existing phases in order
        expect(phases[1].id).toBe("scouting");
        expect(phases[2].id).toBe("scouting_review");
        expect(phases[3].id).toBe("planning");
        expect(phases[4].id).toBe("plan_review");
        expect(phases[5].id).toBe("implementing");
        expect(phases[6].id).toBe("final_review");
    });

    it("has correct structure for each entry", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        const sidebarCalls = onSidebarUpdate.mock.calls
            .map((call: unknown[]) => call[0] as Record<string, unknown>)
            .filter((data: Record<string, unknown>) => data.phases !== undefined);

        const phases = sidebarCalls[0].phases as Array<{ id: string; label: string; icon: string }>;

        // Every entry must have id, label, and icon as non-empty strings
        for (const phase of phases) {
            expect(typeof phase.id).toBe("string");
            expect(phase.id.length).toBeGreaterThan(0);
            expect(typeof phase.label).toBe("string");
            expect(phase.label.length).toBeGreaterThan(0);
            expect(typeof phase.icon).toBe("string");
            expect(phase.icon.length).toBeGreaterThan(0);
        }
    });

    it("does not duplicate phase IDs", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        const sidebarCalls = onSidebarUpdate.mock.calls
            .map((call: unknown[]) => call[0] as Record<string, unknown>)
            .filter((data: Record<string, unknown>) => data.phases !== undefined);

        const phases = sidebarCalls[0].phases as Array<{ id: string }>;

        const ids = phases.map((p) => p.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });

    it("initialization entry uses gear emoji (U+2699)", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        const sidebarCalls = onSidebarUpdate.mock.calls
            .map((call: unknown[]) => call[0] as Record<string, unknown>)
            .filter((data: Record<string, unknown>) => data.phases !== undefined);

        const phases = sidebarCalls[0].phases as Array<{ id: string; icon: string }>;
        const initPhase = phases.find((p) => p.id === "initialization");

        expect(initPhase).toBeDefined();
        expect(initPhase!.icon).toBe("⚙");

        // Verify it's the actual gear emoji character (U+2699)
        expect(initPhase!.icon.codePointAt(0)).toBe(0x2699);
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin", () => realEngin);
});
