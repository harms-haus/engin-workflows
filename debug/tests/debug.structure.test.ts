// ─── Debug Workflow Structural Verification Tests ──────────────────────────
//
// Tests that verify structural properties of the debug workflow.
//
// Part A: Import-based (runtime) — import from debug/main.ts and verify the
//   config shape, exported functions, and re-exported symbols.
// Part B: Text-based (static) — read main.ts and .lib/ as source text and
//   verify structural invariants (no forbidden patterns, correct imports,
//   header comments, etc.).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Capture real module before mocking so we can spread it into the mock.
const realModule = Object.assign({}, await import("@harms-haus/engin-engine"));

mock.module("@harms-haus/engin-engine", () => ({
    ...realModule,
    createHarness: mock(() => { throw new Error("not mocked"); }),
    promptForStructured: mock(() => { throw new Error("not mocked"); }),
    loadProfilesFromDirs: mock(() => { throw new Error("not mocked"); }),
    resolveProfilesDirs: mock(() => []),
    LanePool: mock(function (this: { run: unknown }) {
        this.run = mock(() => { throw new Error("not mocked"); });
    }),
}));

// ─── Runtime imports (after mocks) ─────────────────────────────────────────

import {
    run,
    workflowConfig,
    scoutingPhase,
    scoutingReviewPhase,
    planningPhase,
    implementationPhase,
    finalReviewPhase,
    ScoutingTopicSchema,
    ScoutingGapSchema,
    ScoutingReviewSchema,
    PlanSchema,
    PlanReviewSchema,
    ReviewResultSchema,
    FinalReviewTopicsSchema,
    FinalReviewResultSchema,
    TitleSchema,
    CODE_STEPS,
    NON_CODE_STEPS,
} from "../main";

// ─── Static source text ─────────────────────────────────────────────────────

let mainSource: string;
let libScoutingSource: string;

beforeAll(async () => {
    mainSource = await fs.readFile(
        path.resolve(import.meta.dir, "..", "main.ts"),
        "utf-8",
    );
    libScoutingSource = await fs.readFile(
        path.resolve(import.meta.dir, "..", "..", ".lib", "scouting.ts"),
        "utf-8",
    );
});

// ─── A. Runtime: workflowConfig shape ───────────────────────────────────────

describe("workflowConfig", () => {
    it("is exported and is an object", () => {
        expect(workflowConfig).toBeDefined();
        expect(typeof workflowConfig).toBe("object");
    });

    it("has name: 'debug'", () => {
        expect(workflowConfig.name).toBe("debug");
    });

    it("has defaultMaxConcurrentTasks: 3", () => {
        expect(workflowConfig.defaultMaxConcurrentTasks).toBe(3);
    });

    it("has fixerSteps with exactly 2 steps", () => {
        expect(Array.isArray(workflowConfig.fixerSteps)).toBe(true);
        expect(workflowConfig.fixerSteps).toHaveLength(2);
    });

    it("fixerSteps[0] has name:'fix', profileId:'fixer', isReadOnly:false", () => {
        const step = workflowConfig.fixerSteps[0];
        expect(step.name).toBe("fix");
        expect(step.profileId).toBe("fixer");
        expect(step.isReadOnly).toBe(false);
    });

    it("fixerSteps[1] has name:'verify', profileId:'fixer-reviewer', isReadOnly:true", () => {
        const step = workflowConfig.fixerSteps[1];
        expect(step.name).toBe("verify");
        expect(step.profileId).toBe("fixer-reviewer");
        expect(step.isReadOnly).toBe(true);
    });

    it("has phases as an array with 4 entries (initialization excluded)", () => {
        expect(Array.isArray(workflowConfig.phases)).toBe(true);
        // Initialization is an internal setup step, not a sidebar phase.
        expect(workflowConfig.phases).toHaveLength(4);
    });

    it("phases ids are: scouting, planning, implementing, review", () => {
        const ids = workflowConfig.phases.map((p: { id: string }) => p.id);
        expect(ids).toEqual(["scouting", "planning", "implementing", "review"]);
    });

    it("has titleFormatter as a function", () => {
        expect(typeof workflowConfig.titleFormatter).toBe("function");
    });

    it("titleFormatter passes short strings through unchanged", () => {
        expect(workflowConfig.titleFormatter("short")).toBe("short");
    });

    it("titleFormatter truncates long strings to 100 chars", () => {
        const long = "a".repeat(200);
        expect(workflowConfig.titleFormatter(long)).toHaveLength(100);
    });

    it("finalReviewers is an array of 5 specialized reviewers", () => {
        expect(Array.isArray(workflowConfig.finalReviewers)).toBe(true);
        expect(workflowConfig.finalReviewers).toHaveLength(5);
        const byDim = Object.fromEntries(
            workflowConfig.finalReviewers.map((r: { dimension: string; profileId: string }) => [r.dimension, r]),
        );
        expect(Object.keys(byDim).sort()).toEqual(["code-quality", "documentation", "efficiency", "security", "ui-ux"]);
        expect(byDim.efficiency.profileId).toBe("efficiency-reviewer");
        expect(byDim["code-quality"].profileId).toBe("code-quality-reviewer");
        expect(byDim["ui-ux"].profileId).toBe("ui-ux-reviewer");
        expect(byDim.security.profileId).toBe("security-reviewer");
        expect(byDim.documentation.profileId).toBe("documentation-reviewer");
    });

    it("opts into the council review strategy", () => {
        expect(workflowConfig.reviewStrategy).toBe("council");
        expect(workflowConfig.maxCouncilRounds).toBe(4);
    });
});

// ─── B. Runtime: run function ──────────────────────────────────────────────

describe("run function", () => {
    it("is exported and is a function", () => {
        expect(typeof run).toBe("function");
    });
});

// ─── C. Runtime: named re-exports exist ─────────────────────────────────────

describe("Re-exported phase functions", () => {
    it("scoutingPhase is a function", () => {
        expect(typeof scoutingPhase).toBe("function");
    });
    it("scoutingReviewPhase is a function", () => {
        expect(typeof scoutingReviewPhase).toBe("function");
    });
    it("planningPhase is a function", () => {
        expect(typeof planningPhase).toBe("function");
    });
    it("implementationPhase is a function", () => {
        expect(typeof implementationPhase).toBe("function");
    });
    it("finalReviewPhase is a function", () => {
        expect(typeof finalReviewPhase).toBe("function");
    });
});

describe("Re-exported schemas", () => {
    it("ScoutingTopicSchema is an object (Zod schema)", () => {
        expect(ScoutingTopicSchema).toBeDefined();
        expect(typeof ScoutingTopicSchema.parse).toBe("function");
    });
    it("ScoutingGapSchema", () => {
        expect(typeof ScoutingGapSchema.parse).toBe("function");
    });
    it("ScoutingReviewSchema", () => {
        expect(typeof ScoutingReviewSchema.parse).toBe("function");
    });
    it("PlanSchema", () => {
        expect(typeof PlanSchema.parse).toBe("function");
    });
    it("PlanReviewSchema", () => {
        expect(typeof PlanReviewSchema.parse).toBe("function");
    });
    it("ReviewResultSchema", () => {
        expect(typeof ReviewResultSchema.parse).toBe("function");
    });
    it("FinalReviewTopicsSchema", () => {
        expect(typeof FinalReviewTopicsSchema.parse).toBe("function");
    });
    it("FinalReviewResultSchema", () => {
        expect(typeof FinalReviewResultSchema.parse).toBe("function");
    });
    it("TitleSchema", () => {
        expect(typeof TitleSchema.parse).toBe("function");
    });
});

describe("Re-exported step arrays", () => {
    it("CODE_STEPS is an array with entries", () => {
        expect(Array.isArray(CODE_STEPS)).toBe(true);
        expect(CODE_STEPS.length).toBeGreaterThan(0);
    });
    it("NON_CODE_STEPS is an array with entries", () => {
        expect(Array.isArray(NON_CODE_STEPS)).toBe(true);
        expect(NON_CODE_STEPS.length).toBeGreaterThan(0);
    });
});

// ─── D. Static: main.ts text assertions ────────────────────────────────────

describe("main.ts: imports runSpir from '../.lib/spir'", () => {
    it("imports runSpir from '../.lib/spir'", () => {
        const match = mainSource.match(
            /import\s+.*\brunSpir\b.*from\s+['"]\.\.\/\.lib\/spir['"]/,
        );
        expect(match).not.toBeNull();
    });
});

describe("main.ts: re-exports from '../.lib/spir'", () => {
    it("has export * from '../.lib/spir'", () => {
        const match = mainSource.match(
            /export\s+\*\s+from\s+['"]\.\.\/\.lib\/spir['"]/,
        );
        expect(match).not.toBeNull();
    });
});

describe("main.ts: no parallelAgents", () => {
    it("main.ts contains zero references to parallelAgents", () => {
        expect(mainSource.match(/parallelAgents/g)).toBeNull();
    });

    it(".lib/ contains zero references to parallelAgents", async () => {
        const libDir = path.resolve(import.meta.dir, "..", "..", ".lib");
        const entries = await fs.readdir(libDir);
        for (const entry of entries) {
            if (!entry.endsWith(".ts")) continue;
            const content = await fs.readFile(path.join(libDir, entry), "utf-8");
            expect(content.match(/parallelAgents/g)).toBeNull();
        }
    });
});

describe("main.ts: no DevelopWorkflowOptions", () => {
    it("main.ts contains zero references to DevelopWorkflowOptions", () => {
        expect(mainSource.match(/DevelopWorkflowOptions/g)).toBeNull();
    });

    it("main.ts uses DebugWorkflowOptions", () => {
        const matches = mainSource.match(/DebugWorkflowOptions/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(1);
    });
});

describe("main.ts: header comment", () => {
    it("first meaningful comment contains 'Debug Workflow'", () => {
        const commentLines = mainSource.split("\n").filter((line) =>
            line.trim().startsWith("//") && line.trim().length > 10,
        );
        expect(commentLines.length).toBeGreaterThan(0);
        expect(commentLines[0]).toContain("Debug Workflow");
    });

    it("does NOT contain 'Development Workflow' in the header", () => {
        const commentLines = mainSource.split("\n").filter((line) =>
            line.trim().startsWith("//"),
        );
        const firstContentComment = commentLines.find((line) =>
            line.includes("Workflow"),
        );
        expect(firstContentComment).toBeDefined();
        expect(firstContentComment!).toContain("Debug Workflow");
        expect(firstContentComment!).not.toContain("Development Workflow");
    });
});

describe("main.ts: no errorEvent", () => {
    it("main.ts contains zero references to errorEvent", () => {
        expect(mainSource.match(/errorEvent/g)).toBeNull();
    });

    it("main.ts does not define an errorEvent function", () => {
        const errorEventDef = mainSource.split("\n").find((line) =>
            /function\s+errorEvent/.test(line),
        );
        expect(errorEventDef).toBeUndefined();
    });
});

describe("main.ts: no web renderer imports or references", () => {
    it("does not import from any web/ path", () => {
        const webImports = mainSource.split("\n").filter((line) =>
            line.includes("import") && line.includes("web/"),
        );
        expect(webImports).toHaveLength(0);
    });

    it("does not reference any web renderer", () => {
        const webPatterns = [
            /web\/render/i,
            /createWebRenderer/i,
            /WebRenderer/i,
            /renderToWeb/i,
            /@app\/render/i,
        ];
        for (const pattern of webPatterns) {
            expect(pattern.test(mainSource)).toBe(false);
        }
    });
});

describe("main.ts: opts into council review strategy", () => {
    it("contains reviewStrategy: 'council'", () => {
        expect(mainSource).toContain("reviewStrategy: 'council'");
    });

    it("contains maxCouncilRounds: 4", () => {
        expect(mainSource).toContain("maxCouncilRounds: 4");
    });
});

// ─── E. Static: .lib/scouting.ts text assertions ───────────────────────────

describe(".lib/scouting.ts: scout-coordinator usage", () => {
    it("contains at least 4 references to 'scout-coordinator'", () => {
        const matches = libScoutingSource.match(/scout-coordinator/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(4);
    });
});
