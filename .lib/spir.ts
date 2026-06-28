// ─── SPIR Backbone Orchestrator ──────────────────────────────────────────────
//
// Stateless, config-driven backbone shared by the SPIR workflows (develop /
// improve / debug). Thin wrappers (kb-6) supply a `WorkflowConfig` and call
// `runSpir`. All phase logic lives in the sibling .lib modules; this file
// owns only the phase ordering, the PhaseDefinition[] declaration, the
// SPIR-specific phase hooks, and the top-level orchestrator that drives the
// engine's `PhaseRunner`.
//
// ── Contract migration (kb-28 / E2) ────────────────────────────────────────
//   WorkflowStatusTracker → REMOVED (resume state read from EventStore projection)
//   tracker.taskTracker   → TaskGraph
//   RunnerPool            → SessionScheduler (constructed by phase modules in E3-E6)
//   tracker.setTaskPrompt → onStatus.onWorkflowStart (event)
//   tracker.setWorktree   → onStatus.onWorkflowStart (event)
//   tracker.setWorkflowData → onStatus.onWorkflowData (event)
//   tracker.save/setPhase → REMOVED (PhaseRunner emits via onStatus per D6)
//   tracker.auditLog      → AuditLog from options or constructed from workDir
//   taskTracker.cancelTask → signal abort (SessionScheduler handles cancellation)
//
// Phase execution: each phase's run() callback receives the TaskGraph +
// SessionScheduler factory via closure scope. The phase BODY modules
// (scouting.ts, planning.ts, implementation.ts, final-review.ts) still use
// old APIs — E3-E6 will rewrite them to consume TaskGraph + SessionScheduler
// directly.
import type {
  AuditLog,
  PhaseDefinition,
  PhaseTracker,
  RendererRegistry,
  StatusCallbacks,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  AuditLog as AuditLogCtor,
  PhaseRunner,
  TaskGraph,
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

export const PHASES: readonly Phase[] = [
  "scouting",
  "planning",
  "implementing",
  "review",
  "done",
];

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
  const entry = phases.find((p) => p.id === phase);
  return entry?.icon ?? "⏳";
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
 *
 * Resume state is read from `options.eventStore.getProjection()` — the
 * workflow data (research/scoutingFiles/plan) lives in `projection.workflowData`
 * via the `workflow_data_set` event.
 */
export async function runSpir(
  config: WorkflowConfig,
  taskPrompt: string,
  options: SpirRunOptions,
): Promise<void> {
  const {
    cwd,
    apiKeys,
    workDir,
    onStatus,
    signal,
    eventStore,
    rendererRegistry,
    hookRegistry: optionsHookRegistry,
    worktreeManager,
  } = options;
  const maxConcurrentTasks =
    options.maxConcurrentTasks ?? config.defaultMaxConcurrentSessions;
  const profilesDirs: string[] =
    options.profilesDirs ?? resolveProfilesDirs(options.cwd, config.name);
  const workflowStartTime = Date.now();

  // ── Read resume state from EventStore projection ─────────────────
  //
  // Replaces WorkflowStatusTracker.load(). The projection carries the
  // workflow data (research, scoutingFiles, plan, scoutingReports) via the
  // `workflowData` field, the current/completed phase ids, and stats — all
  // sourced from the event log.
  const projection = eventStore?.getProjection();
  const resumed = (projection?.completedPhaseIds?.length ?? 0) > 0;
  const spirData: SpirWorkflowData = (projection?.workflowData ?? {}) as SpirWorkflowData;
  const currentPhaseId = projection?.currentPhaseId ?? "";

  // ── Emit workflow start (replaces tracker.setTaskPrompt / setWorktree) ──
  onStatus?.onWorkflowStart?.({ taskPrompt, resumed, workDir });

  // ── Register phases via phase_registered events ─────────────────
  // PhaseRunner also emits these via onStatus when provided, but emitting
  // here ensures registration BEFORE the first sidebar update.
  for (const p of config.phases) {
    onStatus?.onPhaseRegister?.({ id: p.id, label: p.label, icon: p.icon });
  }

  // ── Sidebar: initial phase metadata ─────────────────────────────
  const startPhase: Phase = (PHASES as readonly string[]).includes(currentPhaseId)
    ? (currentPhaseId as Phase)
    : PHASES[0];

  // On resume, use truncated title and skip AI generation
  if (resumed) {
    const shortTitle =
      taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + "..." : taskPrompt;
    onStatus?.onSidebarUpdate?.({
      title: shortTitle,
      indicator: getPhaseIndicator(startPhase, config.phases),
    });
  } else {
    // Run AI title generation before entering the main phase loop
    onStatus?.onSidebarUpdate?.({ title: "Initializing...", indicator: "⚙" });
    const title = await initializationPhase(
      profilesDirs,
      taskPrompt,
      cwd,
      apiKeys,
      onStatus,
      // E3-E6: initializationPhase will drop the tracker param; for now it
      // is unused inside the function body, so pass undefined.
      undefined as never,
      workDir,
    );
    onStatus?.onSidebarUpdate?.({
      title,
      indicator: getPhaseIndicator(startPhase, config.phases),
    });
  }

  // ── Build TaskGraph (replaces tracker.taskTracker) ──────────────
  const taskGraph = new TaskGraph();

  // ── Resolve / create the hook registry ──────────────────────────
  const hookRegistry = optionsHookRegistry ?? createHookRegistry();

  // ── Register the default auditor ────────────────────────────────
  //
  // The auditLog is obtained from options (when the engine supplies one) or
  // constructed fresh from workDir. This replaces the old
  // `createDefaultAuditor(tracker.auditLog)` — the tracker is gone.
  const auditLog: AuditLog = options.auditLog ?? new AuditLogCtor(workDir);
  const auditor = createDefaultAuditor(auditLog);
  hookRegistry.register({
    onStructuredOutput: auditor.onStructuredOutput,
    onDecision: auditor.onDecision,
  });

  // ── Helper: emit workflowData via events (replaces tracker.setWorkflowData) ──
  const emitWorkflowData = (data: Record<string, unknown>): void => {
    onStatus?.onWorkflowData?.({ data });
  };

  // ── PhaseDefinition[] — the phase bodies close over runSpir-locals ──
  //
  // Each `run` callback calls the SAME sibling phase body the old
  // `executePhase` switch did. The orchestration (loop, transitions,
  // retry) is owned by the PhaseRunner; the SPIR business logic stays in
  // the workflow layer. The phase bodies close over `taskGraph`,
  // `spirData`, `emitWorkflowData`, etc.
  //
  // NOTE: The phase module calls (scoutingPhase, planningPhase, etc.) still
  // use old signatures that expect WorkflowStatusTracker as first arg. E3-E6
  // will rewrite these modules to consume TaskGraph + SessionScheduler. The
  // `as never` casts on the first argument bridge the red window.
  const phaseRuns: Record<Phase, PhaseDefinition["run"]> = {
    // ── Scouting: get topics → lane-pool scouts → review → loop if needed ──
    scouting: async (ctx) => {
      const state = ctx.state;
      const gaps = (state.scoutingGaps as ScoutingGap[] | undefined) ?? [];
      const rounds = (state.scoutingRounds as number | undefined) ?? 0;

      await scoutingPhase(
        taskGraph as never,
        profilesDirs,
        taskPrompt,
        cwd,
        maxConcurrentTasks,
        workDir,
        apiKeys,
        onStatus,
        ctx.signal,
        {
          topics: gaps.length > 0 ? gaps : undefined,
          round: rounds,
        },
        hookRegistry,
      );

      // Read the cumulative complete scout reports off the task graph for
      // THIS round's review.
      const reports = taskGraph
        .getAllTasks()
        .filter((e) => e.status === "complete" && e.task.phaseId === "scouting")
        .map((e) => e.task.result);

      const review = await scoutingReviewPhase(
        taskGraph as never,
        profilesDirs,
        taskPrompt,
        reports,
        cwd,
        apiKeys,
        onStatus,
        ctx.signal,
        hookRegistry,
        workDir,
      );
      state.scoutingRounds = rounds + 1;
      state.research = review.research;
      state.scoutingGaps = review.gaps;
      state.scoutingFiles = review.files ?? [];
      state.scoutingReady = review.ready;
      emitWorkflowData({
        research: state.research,
        scoutingFiles: state.scoutingFiles,
      });

      if (review.ready || (state.scoutingRounds as number) >= 3) {
        state.scoutingGaps = [];
      }
    },

    // ── Planning: create plan → review → loop if needed ──
    planning: async (ctx) => {
      const state = ctx.state;
      let research = state.research as string | undefined;
      let scoutingFiles = state.scoutingFiles as string[] | undefined;

      // Derive research from projection data if not yet available
      if (!research) {
        if (spirData.research) {
          research = spirData.research;
          scoutingFiles = scoutingFiles ?? spirData.scoutingFiles;
        } else {
          const reports = (spirData.scoutingReports as unknown[]) ?? [];
          const review = await scoutingReviewPhase(
            taskGraph as never,
            profilesDirs,
            taskPrompt,
            reports,
            cwd,
            apiKeys,
            onStatus,
            ctx.signal,
            hookRegistry,
            workDir,
          );
          research = review.research;
          scoutingFiles = review.files ?? [];
          emitWorkflowData({ research, scoutingFiles });
        }
        state.research = research;
        state.scoutingFiles = scoutingFiles;
      }

      const plan = await planningPhase(
        taskGraph as never,
        profilesDirs,
        research,
        scoutingFiles ?? [],
        taskPrompt,
        cwd,
        workDir,
        apiKeys,
        onStatus,
        ctx.signal,
        rendererRegistry,
        hookRegistry,
      );

      state.plan = plan ?? spirData.plan;
    },

    // ── Implementation: run the plan tasks via lane pool ──
    implementing: async (ctx) => {
      const state = ctx.state;
      let plan = state.plan as Plan | undefined;
      if (!plan) {
        plan = spirData.plan;
        state.plan = plan;
      }
      if (plan) {
        await implementationPhase(
          taskGraph as never,
          profilesDirs,
          plan,
          cwd,
          maxConcurrentTasks,
          workDir,
          apiKeys,
          onStatus,
          ctx.signal,
          rendererRegistry,
          hookRegistry,
          worktreeManager,
          config.modelConcurrency ?? {},
        );
      }
    },

    // ── Review: final quality check + fixer loop ──
    review: async (ctx) => {
      await finalReviewPhase(
        taskGraph as never,
        profilesDirs,
        cwd,
        workDir,
        maxConcurrentTasks,
        apiKeys,
        onStatus,
        ctx.signal,
        config.finalReviewers,
        config.fixerSteps,
        config.titleFormatter,
        hookRegistry,
      );
    },

    // ── Done: terminal phase (no-op) ──
    done: async () => {
      // No-op — the runner registers the phase and advances past it.
    },
  };

  const phases: PhaseDefinition[] = PHASES.map((id) => {
    const meta = config.phases.find((p) => p.id === id);
    return {
      id,
      label: meta?.label ?? id.charAt(0).toUpperCase() + id.slice(1),
      icon: meta?.icon ?? "⏳",
      run: phaseRuns[id],
    };
  });

  // ── Register SPIR phase hooks ───────────────────────────────────
  //
  // The SPIR-specific orchestration lives in declarative phase-level hooks.
  // The PhaseRunner now emits onPhaseStart / onPhaseComplete / onPhaseRegister
  // via onStatus itself (D6), so these hooks own only:
  //   • beforePhase          — abort guard
  //   • shouldRetryPhase     — scouting ≤3-rounds retry policy
  //   • onPhaseSettled       — scouting collect-loop
  //   • afterPhase           — sidebar indicator update
  hookRegistry.register({
    // Abort guard: the PhaseRunner has no built-in abort check between
    // phases, so reproduce the legacy `signal?.aborted` guard here. Throwing
    // 'Workflow cancelled' propagates to runSpir's catch block.
    beforePhase: async (_args, ctx) => {
      if (ctx.signal?.aborted) {
        throw new Error("Workflow cancelled");
      }
      return undefined;
    },

    // Scouting ≤3 rounds: retry while the review is not ready AND fewer
    // than 3 rounds have completed. Abstains for every other phase.
    shouldRetryPhase: async (args) => {
      if (args.phaseId !== "scouting") return undefined;
      if (args.state.scoutingReady === true) return undefined;
      const rounds = (args.state.scoutingRounds as number | undefined) ?? 0;
      if (rounds >= 3) return undefined;
      return true;
    },

    // Scouting collect-loop: fold the task graph's settled scout-task
    // results into the shared state bag so the next scouting round (and
    // the planning phase) can read them.
    onPhaseSettled: async (args) => {
      if (args.phaseId !== "scouting") return;
      const reports = args.tasks
        .filter((t) => t.status === "complete" && t.phaseId === "scouting")
        .map((t) => t.result);
      args.state.scoutingReports = reports;
      emitWorkflowData({ scoutingReports: reports });
    },

    // Sidebar indicator update: uses the config-supplied icon for the
    // just-completed phase. PhaseRunner emits onPhaseComplete itself.
    afterPhase: async (args) => {
      onStatus?.onSidebarUpdate?.({
        indicator: getPhaseIndicator(args.phaseId as Phase, config.phases),
      });
    },
  });

  // ── Build PhaseTracker adapter for PhaseRunner ──────────────────
  //
  // PhaseRunner still requires a `PhaseTracker`. Since WorkflowStatusTracker
  // is gone, this adapter satisfies the interface with no-ops (phase
  // registration / transitions flow through onStatus → EventStore per D6) and
  // surfaces the TaskGraph's tasks to the `onPhaseSettled` hook.
  const phaseTracker: PhaseTracker = {
    registerPhase: () => {},
    setPhase: () => {},
    save: async () => {},
    get taskTracker() {
      return {
        getAllTasks: () => taskGraph.getAllTasks().map((e) => e.task),
      };
    },
  };

  // ── Drive the PhaseRunner ───────────────────────────────────────
  //
  // On resume, start from the projection's saved current phase.
  const startIndex = currentPhaseId
    ? Math.max(0, PHASES.indexOf(currentPhaseId as Phase))
    : 0;
  const runnerPhases = startIndex > 0 ? phases.slice(startIndex) : phases;

  const runner = new PhaseRunner({
    phases: runnerPhases,
    tracker: phaseTracker,
    hookRegistry,
    cwd,
    workDir,
    signal,
    onStatus,
  });

  try {
    await runner.run();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // No more tracker.taskTracker.cancelTask — the SessionScheduler (constructed
    // by phase modules) aborts active sessions via `options.signal`. The
    // PhaseRunner's abort signal handles cancellation cooperatively.
    onStatus?.onWorkflowFailed?.({
      error: err,
      phaseId: currentPhaseId,
    });
    if (err.message === "Workflow cancelled") {
      return;
    }
    throw error;
  }

  onStatus?.onSidebarUpdate?.({ indicator: "✅" });
  onStatus?.onWorkflowComplete?.({
    totalDurationMs: Date.now() - workflowStartTime,
    agentCount: projection?.stats?.sessionCount ?? 0,
  });
}
