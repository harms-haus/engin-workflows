import type { RendererRegistry, StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin";
import { runStepTask } from "@harms-haus/engin";
import { open } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { PlanSchema, PlanReviewSchema } from "./schemas";
import type { Plan, PlanReview } from "./schemas";
import { structuredOutputEvent, decisionEvent } from "./helpers";

// ─── Scouting file-context inlining ────────────────────────────────────────
//
// The planner and plan-reviewer are run via runStepTask, which (unlike the
// LanePool path) does NOT auto-inject `task.files`. So that these agents can
// read the key files surfaced by the scouting review WITHOUT spending tool
// calls on `read`, we inline the file contents directly into their prompts.
// This mirrors the engine's pool/prompt-builder.ts behaviour (per-file byte
// cap, binary-skip, graceful failure) so the two paths stay consistent.

/** Per-file byte cap for inlined scouting context (matches the engine's prompt-builder). */
const CONTEXT_FILE_MAX_BYTES = 10_000;

const LANG_BY_EXT: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".md": "markdown",
    ".css": "css", ".scss": "scss", ".html": "html", ".sh": "bash", ".bash": "bash",
    ".sql": "sql", ".toml": "toml", ".rs": "rust", ".go": "go", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
};

const BINARY_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".zip", ".gz", ".tar", ".rar", ".7z",
    ".mp3", ".mp4", ".avi", ".mov", ".wav", ".ogg", ".flac",
    ".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
]);

/** Read one file (relative to `cwd`), capped at CONTEXT_FILE_MAX_BYTES. Returns null on any failure. */
async function readContextFile(fp: string, cwd: string): Promise<string | null> {
    if (BINARY_EXTS.has(extname(fp))) return null;
    const abs = isAbsolute(fp) ? fp : join(cwd, fp);
    try {
        const fh = await open(abs, "r");
        try {
            const { size } = await fh.stat();
            const readLen = Math.min(size, CONTEXT_FILE_MAX_BYTES);
            const buf = Buffer.alloc(readLen);
            await fh.read(buf, 0, readLen, 0);
            const text = buf.toString("utf-8");
            return size > CONTEXT_FILE_MAX_BYTES ? `${text}\n... (truncated)` : text;
        } finally {
            await fh.close();
        }
    } catch {
        return null;
    }
}

/**
 * Build a prompt section inlining the contents of the scouting-review files.
 * Returns "" when there is nothing to inline (no files / all unreadable is
 * still surfaced as a header + path list so the agent at least knows what was
 * flagged).
 */
async function formatScoutingFilesSection(files: string[] | undefined, cwd: string): Promise<string> {
    const unique = [...new Set((files ?? []).filter(Boolean))];
    if (unique.length === 0) return "";

    const blocks: string[] = [];
    for (const fp of unique) {
        const content = await readContextFile(fp, cwd);
        if (content == null) continue;
        const lang = LANG_BY_EXT[extname(fp)] ?? "";
        blocks.push(`### ${fp}\n\`\`\`${lang}\n${content}\n\`\`\``);
    }

    if (blocks.length === 0) {
        return [
            "## Key files flagged by scouting",
            "(These files were flagged by the scouting review but could not be read at the given paths — verify them relative to the repo root.)",
            unique.map((f) => `- ${f}`).join("\n"),
        ].join("\n");
    }
    return [
        "## Key files from scouting (contents inlined — do NOT spend tool calls re-reading these)",
        ...blocks,
    ].join("\n\n");
}

// ─── Phase 3: Planning ──────────────────────────────────────────────────────

/**
 * Create an implementation plan based on the scouting research and task prompt.
 *
 * `files` is the list of key files the scouting review surfaced for this task;
 * their contents are inlined into the planner prompt so the planner can ground
 * its tasks in the real code without re-reading them.
 */
export async function planningPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    research: string,
    files: string[],
    taskPrompt: string,
    cwd: string,
    planReviewFeedback?: string,
    planReviewSuggestions?: string[],
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
    rendererRegistry?: RendererRegistry,
): Promise<Plan> {
    const filesSection = await formatScoutingFilesSection(files, cwd);

    const promptLines: string[] = [
        "You are a planning agent. Based on the research below, create a detailed implementation plan.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research findings:",
        research,
    ];

    if (filesSection) {
        promptLines.push("", filesSection);
    }

    promptLines.push(
        "",
        "Create a plan with specific tasks. Each task should be independently implementable.",
    );

    if (planReviewFeedback) {
        promptLines.push(
            "",
            "Previous plan was rejected. Address the following feedback:",
            planReviewFeedback,
        );
        if (planReviewSuggestions && planReviewSuggestions.length > 0) {
            promptLines.push(
                "",
                "Specific suggestions:",
                ...planReviewSuggestions.map(s => `- ${s}`),
            );
        }
    }

    const prompt = promptLines.join("\n");

    const plan = await runStepTask<Plan>({
        profilesDirs,
        phaseId: "planning",
        taskId: "planner",
        title: "Planner",
        stepName: "plan",
        profileId: "planner",
        cwd,
        apiKeys,
        onStatus,
        isReadOnly: true,
        schema: PlanSchema,
        prompt,
        signal,
        rendererRegistry,
    });

    tracker.setWorkflowData({ plan });

    await tracker.auditLog.append(
        structuredOutputEvent("planner", plan),
    );

    return plan;
}

// ─── Phase 4: Plan Review ───────────────────────────────────────────────────

/**
 * Review the plan and determine if it's ready for implementation.
 *
 * `files` is the same scouting key-files list the planner saw; their contents
 * are inlined so the plan-reviewer can judge the plan against the actual code
 * rather than the planner's summary of it.
 */
export async function planReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    plan: Plan,
    research: string,
    files: string[],
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
    rendererRegistry?: RendererRegistry,
): Promise<PlanReview> {
    const filesSection = await formatScoutingFilesSection(files, cwd);

    const prompt = [
        "You are reviewing an implementation plan. Evaluate it for completeness, correctness, and feasibility.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research context:",
        research,
    ];

    if (filesSection) {
        prompt.push("", filesSection);
    }

    prompt.push(
        "",
        "Proposed plan:",
        JSON.stringify(plan, null, 2),
        "",
        "Approve the plan if it's sound, or provide specific feedback for improvement.",
    );

    const review = await runStepTask<PlanReview>({
        profilesDirs,
        phaseId: "planning",
        taskId: "plan-reviewer",
        title: "Plan Review",
        stepName: "review-plan",
        profileId: "plan-reviewer",
        cwd,
        apiKeys,
        onStatus,
        isReadOnly: true,
        schema: PlanReviewSchema,
        prompt: prompt.join("\n"),
        signal,
        rendererRegistry,
    });

    onStatus?.onDecision?.({
        agentId: "plan-reviewer",
        decision: review.ready ? "plan_approved" : "plan_rejected",
        reasoning: review.feedback,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "plan-reviewer",
            review.ready ? "plan_approved" : "plan_rejected",
            review.feedback,
        ),
    );

    return review;
}
