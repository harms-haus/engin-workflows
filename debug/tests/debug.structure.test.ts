// ─── Debug Workflow Structural Verification Tests ──────────────────────────
//
// Tests that verify structural properties of the debug/main.ts source file
// by reading it as text. These tests ensure:
//   1. No parallelAgents import or reference
//   2. No DevelopWorkflowOptions reference (should be DebugWorkflowOptions)
//   3. resolveProfilesDirs uses 'debug' as the workflow name
//   4. FIXER_STEPS is defined and used (at least 2 occurrences)
//   5. scout-coordinator is used (at least 4 occurrences)
//   6. No errorEvent function
//   7. No web renderer imports or references
//   8. Comment header says 'Debug Workflow'
//   9. Default maxConcurrentTasks is 3 (not 5)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

let source: string;

beforeAll(async () => {
    const filePath = path.resolve(import.meta.dir, "..", "main.ts");
    source = await fs.readFile(filePath, "utf-8");
});

// ─── 1. No parallelAgents ───────────────────────────────────────────────────

describe("No parallelAgents", () => {
    it("contains zero references to parallelAgents", () => {
        const matches = source.match(/parallelAgents/g);
        expect(matches).toBeNull();
    });

    it("does not import parallelAgents", () => {
        const importLine = source.split("\n").find((line) =>
            line.includes("import") && line.includes("parallelAgents"),
        );
        expect(importLine).toBeUndefined();
    });
});

// ─── 2. No DevelopWorkflowOptions ───────────────────────────────────────────

describe("No DevelopWorkflowOptions", () => {
    it("contains zero references to DevelopWorkflowOptions", () => {
        const matches = source.match(/DevelopWorkflowOptions/g);
        expect(matches).toBeNull();
    });

    it("uses DebugWorkflowOptions instead", () => {
        const matches = source.match(/DebugWorkflowOptions/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(2); // definition + RunOptions extends
    });
});

// ─── 3. resolveProfilesDirs uses 'debug' ────────────────────────────────────

describe("resolveProfilesDirs uses 'debug' workflow name", () => {
    it("calls resolveProfilesDirs with 'debug' as the second argument", () => {
        // Should contain resolveProfilesDirs(..., 'debug')
        const lines = source.split("\n");
        const resolveLine = lines.find((line) =>
            line.includes("resolveProfilesDirs") && !line.includes("import"),
        );
        expect(resolveLine).toBeDefined();
        expect(resolveLine!).toContain("'debug'");
        expect(resolveLine!).not.toContain("'develop'");
    });

    it("does not call resolveProfilesDirs with 'develop'", () => {
        const lines = source.split("\n");
        const developResolve = lines.find((line) =>
            line.includes("resolveProfilesDirs") && line.includes("'develop'"),
        );
        expect(developResolve).toBeUndefined();
    });
});

// ─── 4. FIXER_STEPS defined and used ────────────────────────────────────────

describe("FIXER_STEPS", () => {
    it("contains at least 2 references to FIXER_STEPS (definition + usage)", () => {
        const matches = source.match(/FIXER_STEPS/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    it("defines FIXER_STEPS as a constant with StepDefinition type", () => {
        const fixerStepsMatch = source.match(
            /(?:const|let)\s+FIXER_STEPS\s*:\s*StepDefinition\[\]/,
        );
        expect(fixerStepsMatch).not.toBeNull();
    });
});

// ─── 5. scout-coordinator usage ─────────────────────────────────────────────

describe("scout-coordinator usage", () => {
    it("contains at least 4 references to 'scout-coordinator'", () => {
        const matches = source.match(/scout-coordinator/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(4);
    });
});

// ─── 6. No errorEvent function ──────────────────────────────────────────────

describe("No errorEvent function", () => {
    it("contains zero references to errorEvent", () => {
        const matches = source.match(/errorEvent/g);
        expect(matches).toBeNull();
    });

    it("does not define an errorEvent function", () => {
        const lines = source.split("\n");
        const errorEventDef = lines.find((line) =>
            /function\s+errorEvent/.test(line),
        );
        expect(errorEventDef).toBeUndefined();
    });

    it("does not have a const errorEvent arrow function", () => {
        const lines = source.split("\n");
        const errorEventDef = lines.find((line) =>
            /(?:const|let|var)\s+errorEvent/.test(line),
        );
        expect(errorEventDef).toBeUndefined();
    });
});

// ─── 7. No web renderer imports/references ──────────────────────────────────

describe("No web renderer imports or references", () => {
    it("does not import from any web/ path", () => {
        const webImports = source.split("\n").filter((line) =>
            line.includes("import") && line.includes("web/"),
        );
        expect(webImports).toHaveLength(0);
    });

    it("does not reference any web renderer", () => {
        // Check for common web rendering patterns
        const webPatterns = [
            /web\/render/i,
            /createWebRenderer/i,
            /WebRenderer/i,
            /renderToWeb/i,
            /@app\/render/i,
        ];
        for (const pattern of webPatterns) {
            expect(pattern.test(source)).toBe(false);
        }
    });
});

// ─── 8. Comment header ─────────────────────────────────────────────────────

describe("Comment header", () => {
    it("first meaningful comment contains 'Debug Workflow'", () => {
        // Find the first comment line with actual content
        const commentLines = source.split("\n").filter((line) =>
            line.trim().startsWith("//") && line.trim().length > 10,
        );
        expect(commentLines.length).toBeGreaterThan(0);
        expect(commentLines[0]).toContain("Debug Workflow");
    });

    it("does NOT contain 'Development Workflow' in the header", () => {
        const commentLines = source.split("\n").filter((line) =>
            line.trim().startsWith("//"),
        );
        // The first non-empty comment should say 'Debug Workflow', not 'Development Workflow'
        const firstContentComment = commentLines.find((line) =>
            line.includes("Workflow"),
        );
        expect(firstContentComment).toBeDefined();
        expect(firstContentComment!).toContain("Debug Workflow");
        expect(firstContentComment!).not.toContain("Development Workflow");
    });
});

// ─── 9. Default maxConcurrentTasks is 3 ────────────────────────────────────

describe("Default maxConcurrentTasks is 3", () => {
    it("scoutingPhase defaults maxConcurrentTasks to 3", () => {
        // Check that the parameter default is 3, not 5
        const scoutingMatch = source.match(
            /export\s+async\s+function\s+scoutingPhase[\s\S]*?maxConcurrentTasks\s*:\s*number\s*=\s*(\d+)/,
        );
        expect(scoutingMatch).not.toBeNull();
        expect(scoutingMatch![1]).toBe("3");
    });

    it("implementationPhase defaults maxConcurrentTasks to 3", () => {
        const implMatch = source.match(
            /export\s+async\s+function\s+implementationPhase[\s\S]*?maxConcurrentTasks\s*:\s*number\s*=\s*(\d+)/,
        );
        expect(implMatch).not.toBeNull();
        expect(implMatch![1]).toBe("3");
    });

    it("WorkflowTUI maxConcurrentLanes defaults to 3", () => {
        // Find: maxConcurrentLanes: maxConcurrentTasks ?? 3
        const tuiMatch = source.match(
            /maxConcurrentLanes\s*:\s*maxConcurrentTasks\s*\?\?\s*(\d+)/,
        );
        expect(tuiMatch).not.toBeNull();
        expect(tuiMatch![1]).toBe("3");
    });

    it("does NOT have any maxConcurrentTasks default of 5", () => {
        // Ensure no leftover defaults of 5 from the develop workflow
        const defaultFive = source.match(/maxConcurrentTasks\s*(?::\s*number\s*=\s*5|\?\?\s*5)/g);
        expect(defaultFive).toBeNull();
    });
});

// ─── 10. Correct exports ────────────────────────────────────────────────────

describe("Correct exports", () => {
    const expectedExports = [
        "ScoutingTopicSchema",
        "ScoutingTopics",
        "ScoutingGapSchema",
        "ScoutingGap",
        "ScoutingReviewSchema",
        "ScoutingReview",
        "PlanSchema",
        "Plan",
        "PlanReviewSchema",
        "PlanReview",
        "ReviewResultSchema",
        "ReviewResult",
        "FinalReviewTopicsSchema",
        "FinalReviewTopics",
        "TitleSchema",
        "scoutingPhase",
        "scoutingReviewPhase",
        "planningPhase",
        "planReviewPhase",
        "implementationPhase",
        "finalReviewPhase",
        "run",
        "DebugWorkflowOptions",
        "RunOptions",
    ];

    for (const name of expectedExports) {
        it(`exports ${name}`, () => {
            // Check for export keyword before the name
            // For types/interfaces: export type X or export interface X
            // For functions: export async function X or export function X
            // For schemas/variables: export const X
            const patterns = [
                new RegExp(`export\\s+const\\s+${name}\\b`),
                new RegExp(`export\\s+type\\s+${name}\\b`),
                new RegExp(`export\\s+interface\\s+${name}\\b`),
                new RegExp(`export\\s+async\\s+function\\s+${name}\\b`),
                new RegExp(`export\\s+function\\s+${name}\\b`),
            ];
            const found = patterns.some((p) => p.test(source));
            expect(found).toBe(true);
        });
    }
});

// ─── 11. finalReviewPhase uses LanePool with workDir, maxConcurrentTasks, signal ─

describe("finalReviewPhase uses LanePool with correct parameters", () => {
    it("finalReviewPhase function accepts workDir, maxConcurrentTasks, and signal parameters", () => {
        // Verify finalReviewPhase has the expanded parameter list
        const funcMatch = source.match(
            /export\s+async\s+function\s+finalReviewPhase[\s\S]*?\)/,
        );
        expect(funcMatch).not.toBeNull();
        const funcSignature = funcMatch![0];
        expect(funcSignature).toContain("workDir");
        expect(funcSignature).toContain("maxConcurrentTasks");
        expect(funcSignature).toContain("signal");
    });

    it("finalReviewPhase creates a LanePool for fixing", () => {
        // Find the finalReviewPhase function body
        const finalReviewStart = source.indexOf("export async function finalReviewPhase");
        expect(finalReviewStart).toBeGreaterThanOrEqual(0);

        // Get a chunk of the source after the function start
        const afterFunc = source.slice(finalReviewStart, finalReviewStart + 5000);

        // Should contain new LanePool within the function body
        expect(afterFunc).toContain("new LanePool");
    });

    it("finalReviewPhase uses FIXER_STEPS in LanePool getStepsForTask", () => {
        const finalReviewStart = source.indexOf("export async function finalReviewPhase");
        const afterFunc = source.slice(finalReviewStart, finalReviewStart + 5000);

        expect(afterFunc).toContain("FIXER_STEPS");
    });
});
