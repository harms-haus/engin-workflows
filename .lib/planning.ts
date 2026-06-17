import type { RendererRegistry, StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin";
import { ensureDir, parseJsonWithRepair, runStepTask, schemaToString } from "@harms-haus/engin";
import { open, readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { PlanSchema, PlanReviewSchema } from "./schemas";
import type { Plan, PlanReview } from "./schemas";
import { structuredOutputEvent, decisionEvent } from "./helpers";

// ─── Plan artifact paths ───────────────────────────────────────────────────
//
// The planner writes its output as a JSON file under the run's `artifacts`
// directory rather than as a structured text response. A single source of
// truth for the path keeps the planner (which writes it), the orchestrator
// (which reads it back), and the plan-reviewer (which reviews it) in sync.

/** Directory holding durable artifacts for a run (created on demand). */
export function getArtifactsDir(workDir: string): string {
    return join(workDir, "artifacts");
}

/** Absolute path to the plan JSON artifact for a run. */
export function getPlanPath(workDir: string): string {
    return join(getArtifactsDir(workDir), "plan.json");
}

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

/** Concise JSON example of the plan artifact shape (see PlanSchema for the full contract). */
const PLAN_SHAPE_EXAMPLE = `{
  "tasks": [
    {
      "id": "task-1",
      "title": "Short description of the task",
      "prompt": "Detailed prompt for the implementing agent",
      "profile": "implementer",
      "files": ["src/foo.ts"],
      "is_code": true,
      "dependencies": []
    }
  ],
  "strategy": "High-level implementation strategy"
}`;

/**
 * Read and validate the plan JSON artifact written by the planner.
 *
 * Returns `{ plan }` on success, or `{ error }` with a clear, actionable
 * message when the file is missing, unparseable, or fails `PlanSchema`
 * validation. Returning the error (rather than throwing) lets the planner's
 * `validateOutput` retry gate feed it back to the agent.
 */
async function readAndValidatePlan(planPath: string): Promise<{ plan: Plan } | { error: string }> {
    let raw: string;
    try {
        raw = await readFile(planPath, "utf-8");
    } catch {
        return {
            error:
                `No plan file found at ${planPath}. You must use the \`write\` tool to create it ` +
                `(you are sandboxed to the artifacts directory).`,
        };
    }

    let parsed: unknown;
    try {
        parsed = parseJsonWithRepair(raw);
    } catch (err: unknown) {
        return {
            error:
                `The plan file at ${planPath} is not valid JSON: ` +
                (err instanceof Error ? err.message : String(err)),
        };
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
        return { error: `The plan file at ${planPath} failed schema validation: ${result.error.message}` };
    }
    return { plan: result.data };
}

/**
 * Create an implementation plan based on the scouting research and task prompt.
 *
 * Unlike most agents, the planner does NOT respond with structured output.
 * Instead it WRITES its plan to a JSON artifact at `getPlanPath(workDir)` using
 * the `write` tool, confined by a write sandbox to the run's `artifacts`
 * directory. This function runs the planner, then reads and validates that
 * artifact back into a typed `Plan`.
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
    workDir: string,
    planReviewFeedback?: string,
    planReviewSuggestions?: string[],
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
    rendererRegistry?: RendererRegistry,
): Promise<Plan> {
    const artifactsDir = getArtifactsDir(workDir);
    const planPath = getPlanPath(workDir);
    await ensureDir(artifactsDir);

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
        "",
        "## How to deliver your plan",
        `You MUST write your plan as a JSON file at: \`${planPath}\``,
        `Use the \`write\` tool to create that file. You are sandboxed: you may ONLY create or modify files under \`${artifactsDir}\`. Any attempt to write elsewhere will be rejected.`,
        "Do NOT output the plan as text in your response — write it to the file. After writing it, reply with a single short line confirming the path.",
        "",
        "The JSON file must match this shape:",
        "```json",
        PLAN_SHAPE_EXAMPLE,
        "```",
        "Full schema:",
        "```",
        schemaToString(PlanSchema),
        "```",
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

    // The planner writes a FILE (not structured text), so there is no `schema`.
    // Instead, `validateOutput` reads plan.json back, validates it against
    // PlanSchema, and on failure feeds the error back to the planner within the
    // SAME session so it can rewrite the file — up to 3 attempts (handled in
    // runStepTask). The validated plan is captured via closure.
    let plan: Plan | undefined;
    await runStepTask({
        profilesDirs,
        phaseId: "planning",
        taskId: "planner",
        title: "Planner",
        stepName: "plan",
        profileId: "planner",
        cwd,
        apiKeys,
        onStatus,
        isReadOnly: false,
        allowedWriteDirs: [artifactsDir],
        prompt,
        signal,
        rendererRegistry,
        validateOutput: async () => {
            const res = await readAndValidatePlan(planPath);
            if ("plan" in res) {
                plan = res.plan;
                return;
            }
            return { error: res.error };
        },
    });

    // runStepTask throws if validation never passes, so `plan` is guaranteed set.
    const validatedPlan: Plan = plan!;

    tracker.setWorkflowData({ plan: validatedPlan });

    await tracker.auditLog.append(
        structuredOutputEvent("planner", validatedPlan),
    );

    return validatedPlan;
}

// ─── Phase 4: Plan Review ───────────────────────────────────────────────────

/**
 * Review the plan and determine if it's ready for implementation.
 *
 * The reviewer reads the plan from the artifact the planner wrote
 * (`getPlanPath(workDir)`) and its contents are inlined into the prompt, so the
 * reviewer sees the exact file the planner produced — no separate handoff of
 * the parsed `Plan`. It stays fully read-only (no write tools) and responds
 * with structured output.
 *
 * `files` is the same scouting key-files list the planner saw; their contents
 * are inlined so the plan-reviewer can judge the plan against the actual code
 * rather than the planner's summary of it.
 */
export async function planReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    workDir: string,
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

    // Read the plan artifact the planner wrote and inline it verbatim.
    const planPath = getPlanPath(workDir);
    let planText: string;
    try {
        planText = await readFile(planPath, "utf-8");
    } catch {
        throw new Error(
            `Cannot review the plan: no plan file found at ${planPath}. ` +
                `The planning phase must have written it first.`,
        );
    }

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
        "Proposed plan (written by the planner):",
        "```json",
        planText.trim(),
        "```",
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
