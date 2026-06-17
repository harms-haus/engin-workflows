// ─── Output Renderers ────────────────────────────────────────────────────────
//
// Transforms the structured JSON produced by the `planner` and `plan-reviewer`
// agent profiles into a short, human-readable markdown summary. The engine's
// run-manager calls `workflow.registerRenderers(registry)` once before the run
// starts (only when the workflow module exports it); the resulting strings are
// surfaced in the agent log as `render` entries instead of raw JSON.
//
// Renderers must be total: they never throw on malformed input — they fall
// back to `String(data)` so a bad payload degrades to a (boring but safe) line
// rather than crashing the run.
import type { RendererRegistry } from "@harms-haus/engin";
import type { Plan, PlanReview } from "./schemas";

const CHECKMARK = "\u2705"; // ✅
const X_MARK = "\u274C"; // ❌

/**
 * Render a `Plan` as a bulleted task list with dependency annotations.
 *
 *   - <title> (depends on: <dep1>, <dep2>)   — or "(depends on: none)"
 *
 * Falls back to `String(data)` when the input is not an object carrying a
 * `tasks` array.
 */
function renderPlan(data: unknown): string {
    if (data === null || typeof data !== "object" || !Array.isArray((data as { tasks?: unknown }).tasks)) {
        return String(data);
    }

    const tasks = (data as Plan).tasks;
    return tasks
        .map((task) => {
            const title = task?.title ?? "";
            const deps = Array.isArray(task?.dependencies) ? task.dependencies : [];
            const depList = deps.length > 0 ? deps.join(", ") : "none";
            return `- ${title} (depends on: ${depList})`;
        })
        .join("\n");
}

/**
 * Render a `PlanReview` as an approval / rejection line, appending the
 * bulleted suggestions on a rejection.
 *
 *   ready === true  → "✅ Plan Approved: <feedback>"
 *   ready !== true  → "❌ Plan Rejected: <feedback>\nSuggestions:\n- <s1>\n- <s2>"
 *
 * Falls back to `String(data)` when the input is not an object (note that
 * `typeof null === "object"`, so null is handled explicitly).
 */
function renderPlanReview(data: unknown): string {
    if (data === null || typeof data !== "object") {
        return String(data);
    }

    const review = data as PlanReview;
    const feedback = review.feedback ?? "";
    const suggestions = Array.isArray(review.suggestions) ? review.suggestions : [];

    if (review.ready === true) {
        return `${CHECKMARK} Plan Approved: ${feedback}`;
    }

    const suggestionLines = suggestions.map((s) => `- ${s}`).join("\n");
    return `${X_MARK} Plan Rejected: ${feedback}\nSuggestions:\n${suggestionLines}`;
}

/**
 * Register the workflow's output renderers onto a {@link RendererRegistry}.
 *
 * Called by the engine's run-manager (which checks `typeof
 * workflow.registerRenderers === "function"`) before the workflow starts.
 * Renderers are keyed by the producing agent's profile name. Safe to call
 * repeatedly on the same registry.
 */
export function registerRenderers(registry: RendererRegistry): void {
    registry.register("planner", renderPlan);
    registry.register("plan-reviewer", renderPlanReview);
}
