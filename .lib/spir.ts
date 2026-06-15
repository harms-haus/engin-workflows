// ─── SPIR Backbone Orchestrator ──────────────────────────────────────────────
//
// Stateless, config-driven backbone shared by the SPIR workflows (develop /
// improve / debug). Thin wrappers (kb-6) supply a `WorkflowConfig` and call
// `runSpir`. All phase logic lives in the sibling .lib modules; this file
// owns only the phase ordering, the phase-transition helper, the per-phase
// dispatcher, and the top-level orchestrator.
import type { StatusCallbacks } from "@harms-haus/engin";
import { WorkflowStatusTracker, resolveProfilesDirs } from "@harms-haus/engin";
import type { WorkflowConfig, SpirRunOptions } from "./config";
import type { Plan, ScoutingGap } from "./schemas";
import { scoutingPhase, scoutingReviewPhase } from "./scouting";
import { planningPhase, planReviewPhase } from "./planning";
import { implementationPhase } from "./implementation";
import { finalReviewPhase } from "./final-review";
import { initializationPhase } from "./initialization";

// ─── Re-exports (for thin wrappers + tests) ─────────────────────────────────
export * from "./scouting";
export * from "./planning";
export * from "./implementation";
export * from "./final-review";
export * from "./initialization";
export * from "./schemas";
export * from "./steps";
export * from "./config";

// ─── SPIR Workflow Phase Order ───────────────────────────────────────────────

export const PHASES: readonly Phase[] = ["scouting", "planning", "implementing", "review", "done"];

// ─── Phase type (shared by runSpir, completePhase, executePhase) ────────────

export type Phase =
    | "scouting"
    | "planning"
    | "implementing"
    | "review"
    | "done";

/**
 * Mutable state shared across phase executions within a single `runSpir()` call.
 * Passed by reference so `executePhase` mutations are visible to the caller.
 */
export interface RunState {
    research: string;
    plan: Plan | undefined;
    scoutingReports: unknown[];
    scoutingRounds: number;
    scoutingGaps: ScoutingGap[];
    /** Key files the scouting review surfaced for the planner; threaded into planningPhase + planReviewPhase. */
    scoutingFiles?: string[];
    planningRounds: number;
    planReviewFeedback?: string;
    planReviewSuggestions?: string[];
}

export interface SpirWorkflowData {
    research?: string;
    plan?: Plan;
    scoutingReports?: unknown[];
    scoutingFiles?: string[];
    planReviewFeedback?: string;
    planReviewSuggestions?: string[];
}

// ─── Helper: complete a phase transition ────────────────────────────────────

export async function completePhase(
    phase: Phase,
    tracker: WorkflowStatusTracker,
    onStatus: StatusCallbacks | undefined,
    startTime: number,
    nextPhase?: Phase,
): Promise<void> {
    const next = nextPhase ?? PHASES[PHASES.indexOf(phase) + 1];
    if (next) {
        tracker.setPhase(next);
    }
    await tracker.save();
    onStatus?.onPhaseComplete?.({ phase, durationMs: Date.now() - startTime });
}

// ─── Sidebar Phase Indicator ────────────────────────────────────────────────

/**
 * Resolve the sidebar icon for a phase from the config-supplied phase list.
 */
export function getPhaseIndicator(
    phase: Phase,
    phases: { id: string; icon: string }[],
): string {
    const entry = phases.find(p => p.id === phase);
    return entry?.icon ?? '⏳';
}

/**
 * Immutable context built once in `runSpir` and passed to every `executePhase`
 * call. Bundling these related values into a single object eliminates the
 * swap-risk of 12 positional string/optional parameters (e.g. `cwd` vs
 * `workDir`, both strings) and keeps call sites self-documenting.
 */
export interface PhaseContext {
    tracker: WorkflowStatusTracker;
    profilesDirs: string[];
    taskPrompt: string;
    cwd: string;
    workDir: string;
    maxConcurrentTasks: number | undefined;
    config: WorkflowConfig;
    apiKeys?: Record<string, string>;
    onStatus?: StatusCallbacks;
    signal?: AbortSignal;
}

function getSpirData(tracker: WorkflowStatusTracker): SpirWorkflowData {
    return tracker.workflowData as SpirWorkflowData;
}

// ─── Helper: execute a single pipeline phase ───────────────────────────────

/**
 * Execute a single pipeline phase.
 *
 * Each case does exactly ONE step. The caller (`runSpir`) handles advancing
 * phases and looping back when needed (e.g. scouting retries). May return
 * the name of a phase to jump to instead of advancing linearly.
 *
 * `ctx.config` supplies the per-workflow overrides (default concurrency, fixer
 * steps, title formatter, sidebar phase metadata).
 */
export async function executePhase(
    phase: Phase,
    state: RunState,
    ctx: PhaseContext,
): Promise<Phase | void> {
    const {
        tracker, profilesDirs, taskPrompt, cwd, workDir,
        maxConcurrentTasks, config, apiKeys, onStatus, signal,
    } = ctx;
    const phaseStartTime = Date.now();
    const round = (phase === "scouting")
        ? state.scoutingRounds
        : (phase === "planning")
            ? state.planningRounds
            : 0;
    onStatus?.onPhaseStart?.({ phase, round });
    onStatus?.onSidebarUpdate?.({ indicator: getPhaseIndicator(phase, config.phases) });

    switch (phase) {
        // ── Scouting: get topics → lane-pool scouts → review → loop if needed ──
        case "scouting": {
            state.scoutingReports = await scoutingPhase(
                tracker, profilesDirs, taskPrompt, cwd, maxConcurrentTasks,
                workDir, apiKeys, onStatus, signal,
                {
                    // On follow-up rounds, use gaps from the previous review directly
                    topics: state.scoutingGaps.length > 0 ? state.scoutingGaps : undefined,
                    existingReports: state.scoutingRounds > 0 ? state.scoutingReports : undefined,
                    round: state.scoutingRounds,
                },
            );

            const review = await scoutingReviewPhase(
                tracker, profilesDirs, taskPrompt, state.scoutingReports, cwd, apiKeys, onStatus,
            );
            state.scoutingRounds++;
            state.research = review.research;
            state.scoutingGaps = review.gaps;
            state.scoutingFiles = review.files ?? [];
            tracker.setWorkflowData({ research: state.research, scoutingFiles: state.scoutingFiles });

            if (review.ready) {
                state.scoutingGaps = [];
                await completePhase(phase, tracker, onStatus, phaseStartTime);
                break;
            }

            // Not ready — loop back to scouting (max 3 rounds)
            if (state.scoutingRounds < 3) {
                await completePhase(phase, tracker, onStatus, phaseStartTime, "scouting");
                return "scouting";
            }

            // Exhausted rounds — proceed anyway with what we have
            state.scoutingGaps = [];
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Planning: create plan → review → loop if needed ──
        case "planning": {
            // Derive research from saved scouting reports if not yet available
            if (!state.research) {
                if (getSpirData(tracker).research) {
                    state.research = getSpirData(tracker).research!;
                } else {
                    const reports = getSpirData(tracker).scoutingReports ?? [];
                    const review = await scoutingReviewPhase(
                        tracker, profilesDirs, taskPrompt, reports, cwd, apiKeys, onStatus,
                    );
                    state.research = review.research;
                    state.scoutingFiles = review.files ?? [];
                    tracker.setWorkflowData({ research: state.research, scoutingFiles: state.scoutingFiles });
                }
            }

            state.plan = await planningPhase(
                tracker, profilesDirs, state.research, state.scoutingFiles ?? [], taskPrompt, cwd,
                state.planReviewFeedback, state.planReviewSuggestions,
                apiKeys, onStatus,
            );

            if (!state.plan) {
                state.plan = getSpirData(tracker).plan;
            }

            const planReview = await planReviewPhase(
                tracker, profilesDirs, state.plan!, state.research, state.scoutingFiles ?? [], taskPrompt, cwd, apiKeys, onStatus,
            );
            state.planningRounds++;

            if (planReview.ready) {
                state.planReviewFeedback = undefined;
                state.planReviewSuggestions = undefined;
                tracker.setWorkflowData({ planReviewFeedback: undefined, planReviewSuggestions: undefined });
                await completePhase(phase, tracker, onStatus, phaseStartTime);
                break;
            }

            // Not ready — loop back to planning (max 3 rounds)
            state.planReviewFeedback = planReview.feedback;
            state.planReviewSuggestions = planReview.suggestions;
            tracker.setWorkflowData({ planReviewFeedback: planReview.feedback, planReviewSuggestions: planReview.suggestions });
            if (state.planningRounds < 3) {
                state.plan = undefined;
                await completePhase(phase, tracker, onStatus, phaseStartTime, "planning");
                return "planning";
            }

            // Exhausted rounds — proceed anyway with current plan
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Implementation: run the plan tasks via lane pool ──
        case "implementing": {
            // Load plan from tracker on resume
            if (!state.plan) {
                state.plan = getSpirData(tracker).plan;
            }
            if (state.plan) {
                await implementationPhase(
                    tracker, profilesDirs, state.plan, cwd, maxConcurrentTasks, workDir, apiKeys, onStatus, signal,
                );
            }
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Review: final quality check + fixer loop ──
        case "review": {
            await finalReviewPhase(
                tracker, profilesDirs, cwd, workDir, maxConcurrentTasks, apiKeys, onStatus, signal,
                config.finalReviewers, config.fixerSteps, config.titleFormatter,
            );
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        case "done":
            break;
    }
}

// ─── Orchestrator: runSpir ───────────────────────────────────────────────────

/**
 * Run the full SPIR workflow:
 * 1. Scouting (up to 3 rounds)
 * 2. Planning (up to 3 rounds)
 * 3. Implementation
 * 4. Final review
 *
 * Behaviour differences between workflows (develop / improve / debug) are
 * supplied via `config`. Everything else is identical across workflows.
 */
export async function runSpir(
    config: WorkflowConfig,
    taskPrompt: string,
    options: SpirRunOptions,
): Promise<void> {
    const { cwd, apiKeys, workDir, onStatus, signal } = options;
    const maxConcurrentTasks = options.maxConcurrentTasks ?? config.defaultMaxConcurrentTasks;
    const profilesDirs: string[] = options.profilesDirs ?? resolveProfilesDirs(options.cwd, config.name);
    const workflowStartTime = Date.now();

    // Create or load tracker (or reuse a passed-in one)
    let tracker: WorkflowStatusTracker;
    let resumed: boolean;
    if (options.tracker instanceof WorkflowStatusTracker) {
        tracker = options.tracker;
        // A passed tracker is "resumed" only if it has progress from a previous run
        resumed = tracker.completedPhaseIds.length > 0;
    } else {
        try {
            tracker = await WorkflowStatusTracker.load(workDir);
            resumed = true;
        } catch (err: unknown) {
            const isNotFound =
                err instanceof Error && err.message.startsWith("Workflow state file not found");
            if (isNotFound) {
                tracker = new WorkflowStatusTracker(workDir);
                resumed = false;
            } else {
                throw err;
            }
        }
    }

    tracker.setTaskPrompt(taskPrompt);
    if (options.worktree) tracker.setWorktree(options.worktree);
    await tracker.save();

    // The engine composes store + UI + bridge callbacks into onStatus before calling runSpir; the backbone consumes it directly.
    onStatus?.onWorkflowStart?.({ taskPrompt, resumed, workDir });

    // ── Shared mutable state that flows between phases ────────────────
    const state: RunState = {
        research: getSpirData(tracker).research ?? "",
        plan: undefined,
        scoutingReports: [],
        scoutingRounds: 0,
        scoutingGaps: [],
        scoutingFiles: getSpirData(tracker).scoutingFiles ? [...getSpirData(tracker).scoutingFiles!] : undefined,
        planningRounds: 0,
        planReviewFeedback: getSpirData(tracker).planReviewFeedback,
        planReviewSuggestions: getSpirData(tracker).planReviewSuggestions ? [...getSpirData(tracker).planReviewSuggestions!] : undefined,
    };

    // ── Execute phases from the starting point ──────────────────────
    let currentIndex = PHASES.indexOf(tracker.currentPhaseId as Phase);
    if (currentIndex < 0) {
        // Fresh tracker — set the initial phase
        currentIndex = 0;
        tracker.setCurrentPhase(PHASES[0]);
    }

    // ── Register phases via phase_registered events ─────────────────
    for (const p of config.phases) {
        onStatus?.onPhaseRegister?.({ id: p.id, label: p.label, icon: p.icon });
    }

    // ── Sidebar: initial phase metadata ─────────────────────────────
    // On resume, use truncated title and skip AI generation
    if (resumed) {
        const shortTitle = taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
        onStatus?.onSidebarUpdate?.({ title: shortTitle, indicator: getPhaseIndicator(PHASES[currentIndex] as Phase, config.phases) });
    } else {
        // Run AI title generation before entering the main phase loop
        onStatus?.onSidebarUpdate?.({ title: 'Initializing...', indicator: '⚙' });
        const title = await initializationPhase(profilesDirs, taskPrompt, cwd, apiKeys, onStatus, tracker);
        onStatus?.onSidebarUpdate?.({ title, indicator: getPhaseIndicator(PHASES[currentIndex] as Phase, config.phases) });
    }

    // ── Shared context for every executePhase call ───────────────────
    const ctx: PhaseContext = {
        tracker, profilesDirs, taskPrompt, cwd, workDir, maxConcurrentTasks, config, apiKeys, onStatus, signal,
    };

    try {
        while (currentIndex < PHASES.length) {
            const phase = PHASES[currentIndex];
            if (phase === "done") break;

            // Check for cancellation before starting the next phase
            if (signal?.aborted) {
                throw new Error('Workflow cancelled');
            }

            const jumpTo = await executePhase(phase, state, ctx);

            if (jumpTo) {
                currentIndex = PHASES.indexOf(jumpTo);
            } else {
                currentIndex++;
            }
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Always durably persist the tracker state before exiting, regardless of
        // the error type. Without this, a Ctrl+C that aborts mid-execution throws
        // an AbortError (not 'Workflow cancelled') and skips the save — losing the
        // in-memory task statuses (completed tasks, in-flight 'active' tasks) so
        // the next resume can't tell what already ran and re-runs everything.
        await tracker.save();
        onStatus?.onWorkflowFailed?.({ error: err, phaseId: tracker.currentPhaseId });
        if (err.message === 'Workflow cancelled') {
            return;
        }
        throw error;
    }

    onStatus?.onSidebarUpdate?.({ indicator: '✅' });
    onStatus?.onWorkflowComplete?.({ totalDurationMs: Date.now() - workflowStartTime, agentCount: tracker.stats.agentCount });
}
