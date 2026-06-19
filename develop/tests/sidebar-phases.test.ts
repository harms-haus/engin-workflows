// ─── Sidebar Phases Tests ──────────────────────────────────────────────────
//
// Tests that verify the SIDEBAR_PHASES array and phase registration.
// Phases are now registered via onPhaseRegister instead of being embedded
// in onSidebarUpdate.
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

import { run, workflowConfig } from "../main";
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
 * Smart mock for runStepTask that returns appropriate results based on
 * the profileId/taskId being called.
 */
function smartRunStepTask(opts: Record<string, unknown>): unknown {
    const profileId = opts.profileId as string;
    const taskId = opts.taskId as string;

    // Title generator (initialization phase)
    if (taskId === "title-generator" || profileId === "scout") {
        return { title: "AI generated title" };
    }

    // Scout-coordinator
    if (taskId === "scout-coordinator") {
        return { topics: [] };
    }

    // Scouting-reviewer
    if (taskId === "scouting-reviewer") {
        return { ready: true, research: "All scouted", gaps: [] };
    }

    // Planner
    if (taskId === "planner") {
        return { tasks: [], strategy: "none" };
    }

    // Plan-reviewer
    if (taskId === "plan-reviewer") {
        return { ready: true, feedback: "OK", suggestions: [] };
    }

    // Final reviewer (uses runStepTask with schema validation)
    if (typeof taskId === "string" && /(?:efficiency|code-quality|ui-ux|security|documentation)-reviewer-round-\d+$/.test(taskId)) {
        return { dimension: taskId.replace(/-round-\d+$/, "").replace(/-reviewer$/, ""), applicable: true, notApplicableReason: "", summary: "No issues", findings: [] };
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
    mockPromptForStructured
        // final review: clean
        .mockResolvedValueOnce({ result: { topics: [], overallAssessment: "Good", issues: [] }, attempts: 1 });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("workflowConfig.phases", () => {
    it("contains scouting as the first phase entry (initialization is handled separately)", () => {
        const phases = workflowConfig.phases;
        expect(phases).toHaveLength(4);

        // Initialization (title generation) still runs but is no longer listed
        // as a sidebar phase, so scouting is now first.
        expect(phases.find((p) => p.id === "initialization")).toBeUndefined();

        // Entries match the user-facing workflow phases in order
        expect(phases[0].id).toBe("scouting");
        expect(phases[1].id).toBe("planning");
        expect(phases[2].id).toBe("implementing");
        expect(phases[3].id).toBe("review");
    });

    it("has correct structure for each entry", () => {
        const phases = workflowConfig.phases;

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

    it("does not duplicate phase IDs", () => {
        const phases = workflowConfig.phases;
        const ids = phases.map((p) => p.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });

    it("does not surface initialization as a sidebar phase entry", () => {
        // Initialization is an internal setup step (title generation), not a
        // tracked sidebar phase, so it must be absent from config.phases.
        expect(workflowConfig.phases.find((p) => p.id === "initialization")).toBeUndefined();
    });
});

describe("SIDEBAR_PHASES - backward compat", () => {
    it("SIDEBAR_PHASES is exported from the SPIR backbone", async () => {
        // Import PHASES from the SPIR module
        const spir = await import("../../.lib/spir");
        expect(spir.PHASES).toBeDefined();
        expect(Array.isArray(spir.PHASES)).toBe(true);
    });

    it("PHASES does not include initialization (handled separately)", async () => {
        const spir = await import("../../.lib/spir");
        expect(spir.PHASES).not.toContain("initialization");
    });

    it("PHASES contains the expected phase order", async () => {
        const spir = await import("../../.lib/spir");
        expect(spir.PHASES).toEqual([
            "scouting",
            "planning",
            "implementing",
            "review",
            "done",
        ]);
    });
});

describe("onSidebarUpdate call structure", () => {
    it("onSidebarUpdate receives title and indicator", async () => {
        const workDir = tmpDir();
        const onSidebarUpdate = mock();

        await run("Test task", {
            profilesDir: "/profiles",
            cwd: "/project",
            workDir,
            onStatus: { onSidebarUpdate },
        });

        // onSidebarUpdate should have been called multiple times
        expect(onSidebarUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);

        // At least one call should have a title
        const hasTitle = onSidebarUpdate.mock.calls.some(
            (call: unknown[]) => (call[0] as Record<string, unknown>).title !== undefined
        );
        expect(hasTitle).toBe(true);

        // All calls should have an indicator
        for (const call of onSidebarUpdate.mock.calls) {
            const data = call[0] as Record<string, unknown>;
            expect(typeof data.indicator).toBe("string");
        }
    });

    it("onSidebarUpdate does NOT carry phases (phases moved to onPhaseRegister)", async () => {
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
});

describe("onPhaseRegister concept", () => {
    it("config.phases can drive onPhaseRegister calls in order", () => {
        const onPhaseRegister = mock();
        const phases = workflowConfig.phases;

        // Simulate the registration loop that runSpir should perform
        for (const phase of phases) {
            onPhaseRegister({ id: phase.id, label: phase.label, icon: phase.icon });
        }

        // Initialization is no longer a registered sidebar phase.
        expect(onPhaseRegister).toHaveBeenCalledTimes(4);
        expect(onPhaseRegister).toHaveBeenNthCalledWith(1, {
            id: "scouting",
            label: "Scouting",
            icon: "🔍",
        });
        expect(onPhaseRegister).toHaveBeenNthCalledWith(2, {
            id: "planning",
            label: "Planning",
            icon: "📋",
        });
        expect(onPhaseRegister).toHaveBeenNthCalledWith(3, {
            id: "implementing",
            label: "Implementing",
            icon: "🔨",
        });
        expect(onPhaseRegister).toHaveBeenNthCalledWith(4, {
            id: "review",
            label: "Review",
            icon: "🔎",
        });
    });
});

// Restore the real modules so mocks don't leak into other test files.
afterAll(() => {
    mock.module("@harms-haus/engin-engine", () => realEngin);
});
