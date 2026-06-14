import type { StatusCallbacks, StepDefinition, WorkflowStatusTracker } from "@harms-haus/engin";
import { LanePool, TaskTracker, runStepTask } from "@harms-haus/engin";
import { join } from "node:path";
import { FinalReviewResultSchema } from "./schemas";
import type { FinalReviewResult, FinalReviewSeverity } from "./schemas";
import type { FinalReviewerConfig } from "./config";
import { structuredOutputEvent } from "./helpers";

// ─── Phase 6: Multi-Dimensional Final Review ────────────────────────────────
//
// The final review runs several specialized reviewers IN PARALLEL every round
// (by default: efficiency, code-quality, ui-ux, security). Each reviewer
// returns a FinalReviewResult. Findings rated medium/high/critical ("actionable")
// are fed to the fixer LanePool; low-severity findings are recorded but do not
// trigger fixes. After the fixers settle, the reviewers run again. A reviewer
// always receives its OWN complete prior-round history (not just the latest
// round) so it can tell which findings were already addressed.

/** Maximum review → fix → review rounds before giving up (clean=false). */
const MAX_FIX_ROUNDS = 3;

/**
 * Severity ratings that trigger a fixer task. Findings rated "low" are
 * recorded (audit-logged) but do NOT spawn fixers.
 */
const ACTIONABLE_SEVERITIES: readonly FinalReviewSeverity[] = ["medium", "high", "critical"];

export function isActionableSeverity(severity: FinalReviewSeverity): boolean {
    return ACTIONABLE_SEVERITIES.includes(severity);
}

/**
 * Default set of specialized reviewers run in the final review phase when a
 * WorkflowConfig does not specify `finalReviewers`. Each entry maps to an agent
 * profile of the same `profileId` living in the workflow's `profiles/` dir.
 */
export const DEFAULT_FINAL_REVIEWERS: readonly FinalReviewerConfig[] = [
    { profileId: "efficiency-reviewer", dimension: "efficiency", label: "Efficiency" },
    { profileId: "code-quality-reviewer", dimension: "code-quality", label: "Code Quality" },
    { profileId: "ui-ux-reviewer", dimension: "ui-ux", label: "UI/UX" },
    { profileId: "security-reviewer", dimension: "security", label: "Security" },
];

/**
 * Strip an optional `:line` / `:start-end` suffix from a file specifier so the
 * raw path can be used in the fixer task's `files` array
 * (e.g. `"src/auth.ts:42-58"` → `"src/auth.ts"`).
 */
function filePathOnly(spec: string): string {
    return spec.replace(/:\d+.*$/, "");
}

/** Build the prompt for a single reviewer, injecting its full prior-round history. */
function buildReviewerPrompt(
    reviewer: FinalReviewerConfig,
    round: number,
    history: FinalReviewResult[],
): string {
    const lines: string[] = [
        `You are performing the FINAL review of the codebase, focused on a single dimension: ${reviewer.label} (${reviewer.dimension}).`,
        "",
        "Review ALL changes made during this workflow through the lens of this dimension only, and report your findings.",
        "",
        "OUTPUT RULES:",
        "- If this review dimension is NOT applicable to the changeset (for example: a UI/UX review when there are no UI-facing changes, or a security review when there is no security-relevant surface), set applicable=false, explain in notApplicableReason, and return an empty findings array.",
        "- Otherwise set applicable=true and list every real finding, ordered by severity (critical first).",
        "- Rate each finding: low (nit / cosmetic), medium (should fix), high (important), critical (must fix before merge).",
        "- For every finding, write a complete `fixPrompt` that a fixer agent can execute directly and in isolation to resolve it: state the file(s), the exact problem, and the intended fix. Do not reference other findings.",
        "- If there are genuinely no issues for this dimension, return applicable=true with an empty findings array — NEVER fabricate findings.",
        `- Set the \`dimension\` field of your response to exactly "${reviewer.dimension}".`,
    ];

    if (history.length > 0) {
        lines.push(
            "",
            `── PRIOR REVIEW HISTORY for ${reviewer.label} (ALL previous rounds — do NOT re-report resolved findings) ──`,
            "",
        );
        history.forEach((prev, i) => {
            lines.push(`### Round ${i} — ${prev.summary}`);
            if (!prev.applicable) {
                lines.push(`Not applicable: ${prev.notApplicableReason || "(no reason given)"}`);
                return;
            }
            if (prev.findings.length === 0) {
                lines.push("(no findings)");
                return;
            }
            for (const f of prev.findings) {
                lines.push(`- [${f.severity}] ${f.title} — ${f.file}`);
                lines.push(`    ${f.description}`);
            }
        });
        lines.push(
            "",
            `This is round ${round}. Re-assess the CURRENT state of the code. A previously-reported finding that has now been fixed must NOT be reported again. You may still report findings that were not adequately addressed, plus any NEW issues you notice.`,
        );
    }

    return lines.join("\n");
}

/**
 * Perform the multi-dimensional final review of the entire implementation.
 *
 * Each round:
 *   1. Runs every reviewer in `finalReviewers` in parallel (read-only).
 *   2. Audit-logs each result and appends it to that dimension's history.
 *   3. Collects findings rated medium/high/critical from applicable reviews.
 *   4. If there are none → clean, stop.
 *      Otherwise spawns one fixer task per actionable finding via `LanePool`
 *      and loops (up to `MAX_FIX_ROUNDS`).
 *
 * Returns `true` if the codebase was clean (no actionable findings) on the
 * final round.
 */
export async function finalReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    cwd: string,
    workDir: string,
    maxConcurrentTasks: number | undefined,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
    finalReviewers: readonly FinalReviewerConfig[] = DEFAULT_FINAL_REVIEWERS,
    fixerSteps: StepDefinition[] = [{ name: "fix", profileId: "fixer", isReadOnly: false }],
    titleFormatter: (description: string) => string = (d) => d.slice(0, 100),
): Promise<boolean> {
    let clean = false;

    // Per-dimension history: a reviewer sees ALL of its own prior-round results.
    const history: Record<string, FinalReviewResult[]> = {};

    for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
        // 1. Run all reviewers in parallel (independent read-only tasks).
        const entries = await Promise.all(
            finalReviewers.map(async (reviewer) => {
                const result = await runStepTask<FinalReviewResult>({
                    profilesDirs,
                    phaseId: "review",
                    taskId: `${reviewer.profileId}-round-${round}`,
                    title: `Final Review: ${reviewer.label}`,
                    stepName: "final-review",
                    profileId: reviewer.profileId,
                    cwd,
                    apiKeys,
                    onStatus,
                    isReadOnly: true,
                    schema: FinalReviewResultSchema,
                    prompt: buildReviewerPrompt(reviewer, round, history[reviewer.dimension] ?? []),
                    signal,
                });
                return { reviewer, result };
            }),
        );

        // 2. Record history + audit log (sequentially for deterministic ordering).
        for (const { reviewer, result } of entries) {
            (history[reviewer.dimension] ??= []).push(result);
            await tracker.auditLog.append(
                structuredOutputEvent(reviewer.profileId, result, `${reviewer.profileId}-round-${round}`),
            );
        }

        // 3. Collect actionable findings (severity >= medium) from applicable reviews.
        const actionable = entries
            .filter(({ result }) => result.applicable)
            .flatMap(({ reviewer, result }) =>
                result.findings
                    .filter((f) => isActionableSeverity(f.severity))
                    .map((finding) => ({ reviewer, finding })),
            );

        if (actionable.length === 0) {
            clean = true;
            break;
        }

        // 4. Spawn one fixer task per actionable finding and run via LanePool.
        const fixerTracker = new TaskTracker();
        for (let i = 0; i < actionable.length; i++) {
            const { reviewer, finding } = actionable[i];
            fixerTracker.addTask({
                id: `fixer-${i}`,
                title: `Fix [${finding.severity}]: ${titleFormatter(finding.title)}`,
                prompt: [
                    "You are a fix agent. Resolve the following final-review finding.",
                    "",
                    `Review dimension: ${reviewer.label}`,
                    `Severity: ${finding.severity}`,
                    `File: ${finding.file}`,
                    `Title: ${finding.title}`,
                    "",
                    "Finding:",
                    finding.description,
                    "",
                    "Fix instructions (follow exactly; make targeted, minimal changes):",
                    finding.fixPrompt,
                ].join("\n"),
                profile: "fixer",
                files: [filePathOnly(finding.file)],
                dependencies: [],
                isCode: true,
                phaseId: "review",
            });
        }

        const pool = new LanePool({
            maxConcurrentLanes: maxConcurrentTasks ?? 5,
            profilesDirs,
            sessionBaseDir: join(workDir, "sessions", `fix-round-${round}`),
            cwd,
            apiKeys,
            onStatus,
            auditLog: tracker.auditLog,
            taskTracker: fixerTracker,
            getStepsForTask: () => fixerSteps,
            signal,
            phaseId: "review",
        });

        await pool.run();
    }

    return clean;
}
