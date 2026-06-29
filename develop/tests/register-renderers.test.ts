// ─── registerRenderers Tests ──────────────────────────────────────────────
//
// Dedicated tests for the `registerRenderers` named export declared in
// develop/main.ts. It registers output renderers for the `planner` and
// `plan-reviewer` agent profiles on a RendererRegistry.
//
// run-manager.ts calls `workflow.registerRenderers(registry)` before launching
// the workflow (only when the export exists). Each registered renderer takes
// the agent's structured JSON output (typed as `unknown`) and returns a plain
// text markdown summary that is shown in the agent log instead of raw JSON.
//
// This file defines the rendering contract:
//
//   planner (Plan = { tasks: [{ id, title, prompt, profile, files, mode,
//            dependencies }], strategy }):
//     - Guard: if data is not an object whose `tasks` is an array, fall back to
//       `String(data)`.
//     - Otherwise map each task to:
//         '- ' + task.title + ' (depends on: ' +
//           (task.dependencies.length > 0
//              ? task.dependencies.join(', ')
//              : 'none') + ')'
//       and join the lines with '\n'.
//
//   plan-reviewer (PlanReview = { ready, feedback, suggestions }):
//     - Guard: if data is not an object, fall back to `String(data)`.
//     - ready === true  -> '✅ Plan Approved: ' + feedback
//     - ready === false -> '❌ Plan Rejected: ' + feedback + '\nSuggestions:\n'
//                          + suggestions.map(s => '- ' + s).join('\n')
//
// NOTE: Until the `registerRenderers` export is implemented in main.ts, these
// tests fail because the named import resolves to `undefined`. They turn green
// once the implementation lands. This is the expected RED state for the
// write-tests step.
// ────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "bun:test";
import { RendererRegistry } from "@harms-haus/engin-engine";
import { registerRenderers } from "../main";
import * as mainNamespace from "../main";
import type { Plan, PlanReview } from "../main";

// Pin the exact emoji codepoints the renderers must emit.
const CHECKMARK = "\u2705"; // ✅
const X_MARK = "\u274C"; // ❌

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a fresh registry with the workflow's renderers registered. */
function makeRegistry(): RendererRegistry {
    const registry = new RendererRegistry();
    registerRenderers(registry);
    return registry;
}

/** A single fully-formed task with no dependencies. */
function task(overrides: Partial<Plan["tasks"][number]> = {}): Plan["tasks"][number] {
    return {
        id: "t1",
        title: "Create database schema",
        prompt: "Set up the initial schema for the users table",
        profile: "implementer",
        files: ["src/db/schema.ts"],
        mode: "tests_and_code",
        dependencies: [],
        ...overrides,
    };
}

// ─── Export contract ────────────────────────────────────────────────────────

describe("registerRenderers export", () => {
    it("is a named export that is a function", () => {
        expect(typeof registerRenderers).toBe("function");
    });

    it("returns void (undefined)", () => {
        const registry = new RendererRegistry();
        const result = registerRenderers(registry);
        expect(result).toBeUndefined();
    });

    it("registers exactly the planner and plan-reviewer profiles", () => {
        const registry = new RendererRegistry();
        registerRenderers(registry);

        expect(typeof registry.get("planner")).toBe("function");
        expect(typeof registry.get("plan-reviewer")).toBe("function");
    });

    it("does not register other profiles", () => {
        const registry = new RendererRegistry();
        registerRenderers(registry);

        expect(registry.get("scout")).toBeUndefined();
        expect(registry.get("implementer")).toBeUndefined();
        expect(registry.get("does-not-exist")).toBeUndefined();
    });

    it("can be called repeatedly on the same registry without error", () => {
        const registry = new RendererRegistry();
        expect(() => {
            registerRenderers(registry);
            registerRenderers(registry);
        }).not.toThrow();
    });
});

// ─── run-manager detection (module namespace) ─────────────────────────────
//
// run-manager.ts (T7) loads the workflow module via loadWorkflow, which returns
// the full module namespace. It then checks `typeof workflow.registerRenderers
// === 'function'` before invoking it. These tests mirror that exact detection
// path against the imported namespace, so a regression that drops the named
// export is caught here.
describe("run-manager detection via module namespace", () => {
    it("exposes registerRenderers on the module namespace", () => {
        expect(Object.keys(mainNamespace)).toContain("registerRenderers");
    });

    it("namespace.registerRenderers is a function (mirrors typeof check in run-manager)", () => {
        expect(typeof mainNamespace.registerRenderers).toBe("function");
    });

    it("can be invoked through the namespace and returns void", () => {
        const registry = new RendererRegistry();
        // run-manager calls workflow.registerRenderers(registry) directly.
        const result = mainNamespace.registerRenderers(registry);
        expect(result).toBeUndefined();
        expect(typeof registry.get("planner")).toBe("function");
        expect(typeof registry.get("plan-reviewer")).toBe("function");
    });
});

// ─── Planner renderer ───────────────────────────────────────────────────────

describe("planner renderer", () => {
    it("renders a single task with its dependencies", () => {
        const registry = makeRegistry();
        const plan: Plan = {
            tasks: [task({ id: "t1", title: "Set up auth", dependencies: ["t0"] })],
            strategy: "incremental",
        };

        const out = registry.render("planner", plan);

        expect(out).toBe("- Set up auth (depends on: t0)");
    });

    it("lists multiple dependencies comma-separated", () => {
        const registry = makeRegistry();
        const plan: Plan = {
            tasks: [task({ title: "Wire API", dependencies: ["t1", "t2", "t3"] })],
            strategy: "bottom-up",
        };

        expect(registry.render("planner", plan)).toBe("- Wire API (depends on: t1, t2, t3)");
    });

    it("renders 'none' when a task has no dependencies", () => {
        const registry = makeRegistry();
        const plan: Plan = {
            tasks: [task({ title: "Bootstrap project", dependencies: [] })],
            strategy: "start fresh",
        };

        expect(registry.render("planner", plan)).toBe("- Bootstrap project (depends on: none)");
    });

    it("joins multiple task lines with newlines", () => {
        const registry = makeRegistry();
        const plan: Plan = {
            tasks: [
                task({ id: "t1", title: "Define types", dependencies: [] }),
                task({ id: "t2", title: "Implement repo", dependencies: ["t1"] }),
                task({ id: "t3", title: "Add handlers", dependencies: ["t1", "t2"] }),
            ],
            strategy: "layered",
        };

        const out = registry.render("planner", plan);
        const lines = out!.split("\n");

        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe("- Define types (depends on: none)");
        expect(lines[1]).toBe("- Implement repo (depends on: t1)");
        expect(lines[2]).toBe("- Add handlers (depends on: t1, t2)");
    });

    it("returns an empty string when tasks is an empty array", () => {
        const registry = makeRegistry();
        const plan: Plan = { tasks: [], strategy: "nothing to do" };

        expect(registry.render("planner", plan)).toBe("");
    });

    it("always returns a string for valid plan input", () => {
        const registry = makeRegistry();
        const plan: Plan = {
            tasks: [task({ title: "Do thing", dependencies: ["x"] })],
            strategy: "s",
        };

        expect(typeof registry.render("planner", plan)).toBe("string");
    });

    // ── Guard / fallback for malformed input ────────────────────────────────

    it("falls back to String(data) when data is null", () => {
        const registry = makeRegistry();
        expect(registry.render("planner", null)).toBe(String(null));
    });

    it("falls back to String(data) when data is undefined", () => {
        const registry = makeRegistry();
        expect(registry.render("planner", undefined)).toBe(String(undefined));
    });

    it("falls back to String(data) when data is a string primitive", () => {
        const registry = makeRegistry();
        expect(registry.render("planner", "not a plan")).toBe("not a plan");
    });

    it("falls back to String(data) when data is a number primitive", () => {
        const registry = makeRegistry();
        expect(registry.render("planner", 42)).toBe("42");
    });

    it("falls back to String(data) when data is an object without a tasks array", () => {
        const registry = makeRegistry();
        // object present, but no `tasks` field at all
        expect(registry.render("planner", { strategy: "x" })).toBe(String({ strategy: "x" }));
    });

    it("falls back to String(data) when tasks is present but not an array", () => {
        const registry = makeRegistry();
        expect(registry.render("planner", { tasks: "nope" })).toBe(String({ tasks: "nope" }));
        expect(registry.render("planner", { tasks: { a: 1 } })).toBe(String({ tasks: { a: 1 } }));
        expect(registry.render("planner", { tasks: null })).toBe(String({ tasks: null }));
    });

    it("does not throw when a task is missing fields", () => {
        const registry = makeRegistry();
        // Defensive: a malformed task object should not crash the renderer.
        expect(() => registry.render("planner", { tasks: [{}] })).not.toThrow();
    });
});

// ─── Plan-reviewer renderer ─────────────────────────────────────────────────

describe("plan-reviewer renderer", () => {
    it("renders an approval (ready: true) with a checkmark", () => {
        const registry = makeRegistry();
        const review: PlanReview = {
            ready: true,
            feedback: "Plan looks solid",
            suggestions: [],
        };

        const out = registry.render("plan-reviewer", review);
        expect(out).toBe(`${CHECKMARK} Plan Approved: Plan looks solid`);
        // Starts with the exact checkmark emoji codepoint (U+2705).
        expect(out!.codePointAt(0)).toBe(0x2705);
        expect(out).toBe("✅ Plan Approved: Plan looks solid");
    });

    it("renders a rejection (ready: false) with an X and suggestions", () => {
        const registry = makeRegistry();
        const review: PlanReview = {
            ready: false,
            feedback: "Missing test coverage",
            suggestions: ["Add unit tests for auth", "Document the public API"],
        };

        const expected =
            `${X_MARK} Plan Rejected: Missing test coverage\n` +
            "Suggestions:\n" +
            "- Add unit tests for auth\n" +
            "- Document the public API";
        const out = registry.render("plan-reviewer", review);

        expect(out).toBe(expected);
        // Starts with the exact X emoji codepoint (U+274C).
        expect(out!.codePointAt(0)).toBe(0x274c);
        expect(out).toBe(
            "❌ Plan Rejected: Missing test coverage\n" +
                "Suggestions:\n" +
                "- Add unit tests for auth\n" +
                "- Document the public API",
        );
    });

    it("prefixes every suggestion with '- '", () => {
        const registry = makeRegistry();
        const review: PlanReview = {
            ready: false,
            feedback: "Needs work",
            suggestions: ["first", "second", "third"],
        };

        const out = registry.render("plan-reviewer", review)!;
        const lines = out.split("\n");

        // header line, "Suggestions:" line, then three suggestion lines
        expect(lines).toHaveLength(5);
        expect(lines[2]).toBe("- first");
        expect(lines[3]).toBe("- second");
        expect(lines[4]).toBe("- third");
    });

    it("renders a rejection with a single suggestion", () => {
        const registry = makeRegistry();
        const review: PlanReview = {
            ready: false,
            feedback: "One thing to fix",
            suggestions: ["only suggestion"],
        };

        expect(registry.render("plan-reviewer", review)).toBe(
            "❌ Plan Rejected: One thing to fix\nSuggestions:\n- only suggestion",
        );
    });

    it("includes the feedback verbatim in both approval and rejection", () => {
        const registry = makeRegistry();
        const tricky = "Plan with `code` & \"quotes\" — multi\nline feedback";

        const approved = registry.render("plan-reviewer", { ready: true, feedback: tricky, suggestions: [] })!;
        expect(approved).toContain(tricky);

        const rejected = registry.render("plan-reviewer", { ready: false, feedback: tricky, suggestions: [] })!;
        expect(rejected).toContain(tricky);
    });

    it("always returns a string for valid review input", () => {
        const registry = makeRegistry();
        expect(typeof registry.render("plan-reviewer", { ready: true, feedback: "ok", suggestions: [] })).toBe(
            "string",
        );
    });

    // ── Guard / fallback for malformed input ────────────────────────────────

    it("falls back to String(data) when data is null", () => {
        const registry = makeRegistry();
        expect(registry.render("plan-reviewer", null)).toBe(String(null));
    });

    it("falls back to String(data) when data is undefined", () => {
        const registry = makeRegistry();
        expect(registry.render("plan-reviewer", undefined)).toBe(String(undefined));
    });

    it("falls back to String(data) when data is a string primitive", () => {
        const registry = makeRegistry();
        expect(registry.render("plan-reviewer", "oops")).toBe("oops");
    });

    it("falls back to String(data) when data is a number primitive", () => {
        const registry = makeRegistry();
        expect(registry.render("plan-reviewer", 7)).toBe("7");
    });

    it("falls back to String(data) when data is a boolean primitive", () => {
        const registry = makeRegistry();
        expect(registry.render("plan-reviewer", true)).toBe(String(true));
    });
});

// ─── Registry integration (mirrors run-manager usage) ───────────────────────

describe("registerRenderers via RendererRegistry.render", () => {
    it("planner output is retrievable through registry.render (not undefined)", () => {
        const registry = makeRegistry();
        const plan: Plan = {
            tasks: [task({ title: "Task A", dependencies: ["d"] })],
            strategy: "s",
        };

        const out = registry.render("planner", plan);
        expect(out).not.toBeUndefined();
        expect(out).toContain("- Task A (depends on: d)");
    });

    it("plan-reviewer output is retrievable through registry.render (not undefined)", () => {
        const registry = makeRegistry();
        const review: PlanReview = { ready: true, feedback: "Approved", suggestions: [] };

        const out = registry.render("plan-reviewer", review);
        expect(out).not.toBeUndefined();
        expect(out).toBe("✅ Plan Approved: Approved");
    });

    it("unregistered profiles render to undefined", () => {
        const registry = makeRegistry();
        expect(registry.render("some-other-profile", { ready: true })).toBeUndefined();
    });
});
