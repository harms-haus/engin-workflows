// ─── SPIR Backbone Orchestrator ──────────────────────────────────────────────
//
// Stateless, config-driven backbone shared by the SPIR workflows (develop /
// improve / debug). Thin wrappers (kb-6) supply a `WorkflowConfig` and call
// `runSpir`. All phase logic lives in the sibling .lib modules; this file
// owns only the phase ordering, the PhaseDefinition[] declaration, the
// SPIR-specific phase hooks, and the top-level orchestrator that drives the
// engine's `PhaseRunner`.
//
// The hand-written `executePhase` switch + `runSpir` phase loop have been
// replaced by `PhaseRunner` (task-20): phases are declared as
// `PhaseDefinition[]` (`{ id, label, icon, run }`), and the SPIR-specific
// orchestration (scouting ≤3-rounds retry, scouting collect-loop, sidebar
// indicator) is registered as phase-level hooks on the hookRegistry.
import type {
    PhaseDefinition,
    RendererRegistry,
    StatusCallbacks,
    WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
    PhaseRunner,
    WorkflowStatusTracker,
    createDefaultAuditor,
    createHookRegistry,
    resolveProfilesDirs,
} from "@harms-haus/engin-engine";
import type { WorkflowConfig, SpirRunOptions } from "./config";
import type { Plan, ScoutingGap } from "./schemas";
import { scoutingPhase, scoutingReviewPhase } from "./scouting";
import { planningPhase } from "./planning";
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
export * from "./renderers";

// ─── SPIR Workflow Phase Order ───────────────────────────────────────────────

export const PHASES: readonly Phase[] = ["scouting", "planning", "implementing", "review", "done"];

// ─── Phase type (shared by runSpir + PhaseDefinition declaration) ──────────

export type Phase =
    | "scouting"
    | "planning"
    | "implementing"
    | "review"
    | "done";

export interface SpirWorkflowData {
    research?: string;
    plan?: Plan;
    scoutingReports?: unknown[];
    scoutingFiles?: string[];
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

function getSpirData(tracker: WorkflowStatusTracker): SpirWorkflowData {
    return tracker.workflowData as SpirWorkflowData;
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
 *
 * The phase loop is driven by the engine's `PhaseRunner`: phases are declared
 * as a `PhaseDefinition[]` and the SPIR-specific orchestration (scouting retry,
 * scouting collect-loop, sidebar indicator) is registered as phase-level hooks
 * on the (created or passed-in) hookRegistry.
 */
export async function runSpir(
    config: WorkflowConfig,
    taskPrompt: string,
    options: SpirRunOptions,
): Promise<void> {
    const {
        cwd, apiKeys, workDir, onStatus, signal, rendererRegistry,
        hookRegistry: optionsHookRegistry,
    } = options;
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

    // ── Register phases via phase_registered events ─────────────────
    for (const p of config.phases) {
        onStatus?.onPhaseRegister?.({ id: p.id, label: p.label, icon: p.icon });
    }

    // ── Sidebar: initial phase metadata ─────────────────────────────
    // Resolve the starting phase for the initial sidebar indicator. The
    // PhaseRunner drives the actual transitions; this is display-only.
    const currentId = tracker.currentPhaseId;
    const startPhase: Phase = (PHASES as readonly string[]).includes(currentId) ? (currentId as Phase) : PHASES[0];

    // On resume, use truncated title and skip AI generation
    if (resumed) {
        const shortTitle = taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
        onStatus?.onSidebarUpdate?.({ title: shortTitle, indicator: getPhaseIndicator(startPhase, config.phases) });
    } else {
        // Run AI title generation before entering the main phase loop
        onStatus?.onSidebarUpdate?.({ title: 'Initializing...', indicator: '⚙' });
        const title = await initializationPhase(profilesDirs, taskPrompt, cwd, apiKeys, onStatus, tracker);
        onStatus?.onSidebarUpdate?.({ title, indicator: getPhaseIndicator(startPhase, config.phases) });
    }

    // ── Resolve / create the hook registry ──────────────────────────
    //
    // Thread `options.hookRegistry` (engine-assembled) when supplied;
    // otherwise create a fresh registry so the SPIR phase hooks have a home.
    // Infer the type from the `??` expression so the interface-typed
    // `optionsHookRegistry` and the class-typed `createHookRegistry()` both
    // widen to the structural `HookRegistry` interface (the type
    // `PhaseRunnerOptions.hookRegistry` expects).
    //
    // Declared BEFORE the phase bodies so the `implementing` closure can
    // forward the resolved (never-`undefined`) registry into
    // `implementationPhase`, which registers its `beforeTask` step-substitution
    // hook against it. (Phase bodies are async closures executed later by the
    // PhaseRunner, so there is no TDZ concern at runtime; declaring it here
    // keeps the data-flow obvious.)
    const hookRegistry = optionsHookRegistry ?? createHookRegistry();
    // Register the default auditor once so both LanePool and runStepTask paths
    // audit structured_output/decision events. Spreading the auditor's
    // onStructuredOutput + onDecision observe-hook subscribers against the
    // resolved registry is what translates the engine's fires into durable
    // AuditLog appends (replacing the deleted per-phase manual appends).
    const auditor = createDefaultAuditor(tracker.auditLog);
    hookRegistry.register({
        onStructuredOutput: auditor.onStructuredOutput,
        onDecision: auditor.onDecision,
    });

    // ── PhaseDefinition[] — the phase bodies close over runSpir-locals ──
    //
    // Each `run` callback calls the SAME sibling phase body the old
    // `executePhase` switch did. The orchestration (loop, transitions,
    // retry) is owned by the PhaseRunner; the SPIR business logic stays in
    // the workflow layer. `ctx.state` is the PhaseRunner's shared mutable
    // state bag — the fields mirror the legacy `RunState` (research, plan,
    // scoutingReports, scoutingRounds, scoutingGaps, scoutingFiles) plus
    // `scoutingReady`, which the `shouldRetryPhase` hook reads.
    const phaseRuns: Record<Phase, PhaseDefinition['run']> = {
        // ── Scouting: get topics → lane-pool scouts → review → loop if needed ──
        scouting: async (ctx) => {
            const state = ctx.state;
            const gaps = (state.scoutingGaps as ScoutingGap[] | undefined) ?? [];
            const rounds = (state.scoutingRounds as number | undefined) ?? 0;

            // scoutingPhase adds scout tasks to the SHARED tracker and runs the
            // LanePool against it. It no longer collects/returns reports — the
            // onPhaseSettled hook owns cross-round accumulation + persistence
            // (it re-reads the same shared tracker once the phase settles).
            await scoutingPhase(
                tracker, profilesDirs, taskPrompt, cwd, maxConcurrentTasks,
                workDir, apiKeys, onStatus, ctx.signal,
                {
                    // On follow-up rounds, use gaps from the previous review directly
                    topics: gaps.length > 0 ? gaps : undefined,
                    round: rounds,
                },
                hookRegistry,
            );

            // Read the cumulative complete scout reports off the shared tracker
            // for THIS round's review. Scout tasks accumulate across rounds on
            // the same tracker, so this naturally includes every prior round's
            // reports (no manual existingReports threading needed) — matching
            // exactly what the onPhaseSettled hook will fold into state.
            const reports = tracker.taskTracker
                .getAllTasks()
                .filter(t => t.status === 'complete' && t.phaseId === 'scouting')
                .map(t => t.result);

            const review = await scoutingReviewPhase(
                tracker, profilesDirs, taskPrompt, reports, cwd, apiKeys, onStatus,
                ctx.signal, hookRegistry,
            );
            state.scoutingRounds = rounds + 1;
            state.research = review.research;
            state.scoutingGaps = review.gaps;
            state.scoutingFiles = review.files ?? [];
            state.scoutingReady = review.ready;
            tracker.setWorkflowData({ research: state.research, scoutingFiles: state.scoutingFiles });

            // Clear gaps when ready OR when rounds are exhausted (proceed with
            // current research either way). The shouldRetryPhase hook breaks
            // the loop; clearing gaps here ensures the planner never sees
            // stale follow-up topics.
            if (review.ready || (state.scoutingRounds as number) >= 3) {
                state.scoutingGaps = [];
            }
        },

        // ── Planning: create plan → review → loop if needed ──
        planning: async (ctx) => {
            const state = ctx.state;
            let research = state.research as string | undefined;
            let scoutingFiles = state.scoutingFiles as string[] | undefined;

            // Derive research from saved scouting reports if not yet available
            if (!research) {
                const data = getSpirData(tracker);
                if (data.research) {
                    research = data.research;
                    scoutingFiles = scoutingFiles ?? data.scoutingFiles;
                } else {
                    const reports = (data.scoutingReports as unknown[]) ?? [];
                    const review = await scoutingReviewPhase(
                        tracker, profilesDirs, taskPrompt, reports, cwd, apiKeys, onStatus,
                        ctx.signal, hookRegistry,
                    );
                    research = review.research;
                    scoutingFiles = review.files ?? [];
                    tracker.setWorkflowData({ research, scoutingFiles });
                }
                state.research = research;
                state.scoutingFiles = scoutingFiles;
            }

            // planningPhase runs plan → review-plan as a single two-step task
            // that owns its own replan-on-rejection loop internally, so this
            // body just runs it once and advances.
            const plan = await planningPhase(
                tracker, profilesDirs, research, scoutingFiles ?? [], taskPrompt, cwd, workDir,
                apiKeys, onStatus, ctx.signal,
                rendererRegistry,
                // Thread the resolved hook registry (the one the default auditor
                // was registered against) instead of the raw options value, so
                // the planning phase's runMultiStepTask observes fire.
                hookRegistry,
            );

            state.plan = plan ?? getSpirData(tracker).plan;
        },

        // ── Implementation: run the plan tasks via lane pool ──
        implementing: async (ctx) => {
            const state = ctx.state;
            let plan = state.plan as Plan | undefined;
            // Load plan from tracker on resume
            if (!plan) {
                plan = getSpirData(tracker).plan;
                state.plan = plan;
            }
            if (plan) {
                await implementationPhase(
                    tracker, profilesDirs, plan, cwd, maxConcurrentTasks, workDir, apiKeys, onStatus, ctx.signal,
                    rendererRegistry,
                    // Thread the resolved hook registry (never `undefined`) so the
                    // implementation phase can register its `beforeTask` step-substitution
                    // hook AND so the engine's default auditor / prompt hooks fire for
                    // its lane pool. Without this, the removed `getStepsForTask` shim
                    // would leave the pool with no step source.
                    hookRegistry,
                );
            }
        },

        // ── Review: final quality check + fixer loop ──
        review: async (ctx) => {
            await finalReviewPhase(
                tracker, profilesDirs, cwd, workDir, maxConcurrentTasks, apiKeys, onStatus, ctx.signal,
                config.finalReviewers, config.fixerSteps, config.titleFormatter,
                hookRegistry,
            );
        },

        // ── Done: terminal phase (no-op) ──
        done: async () => {
            // No-op — the runner registers the phase and advances past it.
        },
    };

    const phases: PhaseDefinition[] = PHASES.map((id) => {
        const meta = config.phases.find(p => p.id === id);
        return {
            id,
            label: meta?.label ?? (id.charAt(0).toUpperCase() + id.slice(1)),
            icon: meta?.icon ?? '⏳',
            run: phaseRuns[id],
        };
    });

    // ── Register SPIR phase hooks ───────────────────────────────────
    //
    // The SPIR-specific orchestration moves OUT of the imperative loop and
    // INTO declarative phase-level hooks on the registry. The old
    // `executePhase` switch / `completePhase` helper fired StatusCallbacks
    // (onPhaseStart, onPhaseComplete) and had an explicit signal-abort guard;
    // the PhaseRunner doesn't fire these itself, so they are re-emitted here
    // via the registry hooks. The hook set is:
    //   • beforePhase          — abort guard + onPhaseStart callback
    //   • shouldRetryPhase     — scouting ≤3-rounds retry policy
    //   • onPhaseSettled       — scouting collect-loop (task-38)
    //   • afterPhase           — onPhaseComplete callback + sidebar indicator
    hookRegistry.register({
        // Abort guard + onPhaseStart: the PhaseRunner has no built-in abort
        // check between phases, so reproduce the legacy `signal?.aborted` guard
        // here. Throwing 'Workflow cancelled' propagates to runSpir's catch
        // block, which cancels active tasks and persists the tracker. The
        // onPhaseStart callback carries the phase id and a round number
        // (scoutingRounds for scouting, else 0) — matching the legacy
        // `executePhase` payload shape.
        beforePhase: async (args, ctx) => {
            if (ctx.signal?.aborted) {
                throw new Error('Workflow cancelled');
            }
            const round = args.phaseId === 'scouting'
                ? ((args.state.scoutingRounds as number | undefined) ?? 0)
                : 0;
            onStatus?.onPhaseStart?.({ phase: args.phaseId, round });
            // Returning undefined abstains — the phase runs normally.
            return undefined;
        },

        // Scouting ≤3 rounds: retry while the review is not ready AND fewer
        // than 3 rounds have completed. Abstains (returns undefined) for every
        // other phase so non-scouting phases keep their default behavior.
        shouldRetryPhase: async (args) => {
            if (args.phaseId !== 'scouting') return undefined;
            if (args.state.scoutingReady === true) return undefined;
            const rounds = (args.state.scoutingRounds as number | undefined) ?? 0;
            if (rounds >= 3) return undefined;
            return true;
        },

        // Scouting collect-loop: fold the tracker's settled scout-task results
        // into the shared state bag so the next scouting round (and the
        // planning phase) can read them. Because scout tasks accumulate on the
        // SHARED tracker across the ≤3 rounds, this collection is naturally
        // cumulative (it overwrites state.scoutingReports with the full set
        // each settlement). The reports are ALSO persisted to workflowData so
        // the planning phase's resume path (which reads data.scoutingReports)
        // works — the PhaseRunner persists only its setPhase transitions, not
        // the shared state bag, so persistence must be explicit here.
        // Non-scouting phases are untouched.
        onPhaseSettled: async (args) => {
            if (args.phaseId !== 'scouting') return;
            const reports = args.tasks
                .filter(t => t.status === 'complete' && t.phaseId === 'scouting')
                .map(t => t.result);
            args.state.scoutingReports = reports;
            tracker.setWorkflowData({ scoutingReports: reports });
        },

        // onPhaseComplete callback + sidebar indicator update: mirrors the
        // legacy `completePhase`'s two side effects. The onPhaseComplete
        // payload carries the phase id and the runner-measured durationMs;
        // the sidebar indicator uses the config-supplied icon for the phase.
        afterPhase: async (args) => {
            onStatus?.onPhaseComplete?.({ phase: args.phaseId, durationMs: args.durationMs });
            onStatus?.onSidebarUpdate?.({
                indicator: getPhaseIndicator(args.phaseId as Phase, config.phases),
            });
        },
    });

    // ── Drive the PhaseRunner ───────────────────────────────────────
    //
    // On resume, start from the tracker's saved current phase. The runner
    // always begins at index 0, so we slice the phase list to the resume
    // target and clear the tracker's current-phase marker (so the runner's
    // first `setPhase` doesn't double-push the resume target into
    // completedPhaseIds before its body runs).
    const startIndex = currentId ? Math.max(0, PHASES.indexOf(currentId as Phase)) : 0;
    const runnerPhases = startIndex > 0 ? phases.slice(startIndex) : phases;
    if (startIndex > 0) {
        tracker.setCurrentPhase('');
    }

    const runner = new PhaseRunner({
        phases: runnerPhases,
        tracker,
        hookRegistry,
        cwd,
        workDir,
        signal,
    });

    try {
        await runner.run();
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Cancel all still-active tasks so an abort (Ctrl+C / signal) doesn't
        // leave them half-finished — without this the next resume can't tell
        // what already ran and re-runs everything.
        for (const task of tracker.taskTracker.getAllTasks()) {
            if (task.status === 'active') {
                try {
                    tracker.taskTracker.cancelTask(task.id);
                } catch {
                    // ignore — the task may have settled between getAllTasks and cancelTask
                }
            }
        }
        // Always durably persist the tracker state before exiting, regardless of
        // the error type, so the in-memory task statuses survive for resume.
        await tracker.save();
        onStatus?.onWorkflowFailed?.({ error: err, phaseId: tracker.currentPhaseId });
        if (err.message === 'Workflow cancelled') {
            return;
        }
        throw error;
    }

    onStatus?.onSidebarUpdate?.({ indicator: '✅' });
    onStatus?.onWorkflowComplete?.({
        totalDurationMs: Date.now() - workflowStartTime,
        agentCount: tracker.stats.agentCount,
    });
}
