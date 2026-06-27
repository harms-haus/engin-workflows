import type {
  RunSessionContext,
  RunnerContext,
  SessionResult,
  SessionSpec,
  StatusCallbacks,
  Task,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import {
  SessionGate,
  loadProfilesFromDirs,
  runSession,
  singleSession,
} from "@harms-haus/engin-engine";

// ─── runSingleSessionStructured helper ──────────────────────────────────────
//
// Run a single structured-output session via `singleSession`, capturing the
// structured `SessionResult` through a wrapped `runSession` in the
// `RunnerContext`. The `singleSession` runner internally calls `ctx.runSession`;
// by providing a wrapped `runSession`, the structured result is captured into a
// closure variable even though the runner itself only returns
// `{ status: 'completed' }`.
//
// Returns the parsed structured data, or `undefined` when the session did not
// produce structured output.
//
// Task lifecycle: this helper emits the full task-lifecycle status callbacks
// (onTaskRegister / onTaskStart / onTaskComplete|onTaskRejected) so the TUI/web
// — which is event-sourced — can display the session as a real, owned task.
// It does NOT register the task in any shared TaskTracker. The tracker is the
// RunnerPool's work queue; inserting a meta-task there would pollute it (the
// pool would later claim and mis-run it) and the tracker's completeTask/
// failTask require a ready→active claim transition that single-session paths
// don't perform. Events are sufficient for the UI projection.

export async function runSingleSessionStructured<T>(
  spec: Omit<SessionSpec, "id"> & { role: string },
  opts: {
    profilesDirs: string[];
    cwd: string;
    sessionBaseDir: string;
    apiKeys?: Record<string, string>;
    onStatus?: StatusCallbacks;
    hookRegistry?: WorkflowRunOptions["hookRegistry"];
    signal?: AbortSignal;
    phaseId: string;
    agentId: string;
    taskId: string;
    taskTitle: string;
  },
): Promise<T | undefined> {
  const profiles = await loadProfilesFromDirs(opts.profilesDirs);
  const gate = new SessionGate({ total: 1, perModel: {} });

  // The task is used as the runner context's task identity (so the runner and
  // session primitive agree on task.id for session-id derivation) AND announced
  // via status callbacks so the UI binds this session's agentId to a task.
  const task: Task = {
    id: opts.taskId,
    title: opts.taskTitle,
    prompt: spec.prompt,
    profile: spec.profile,
    files: [],
    dependencies: [],
    status: "ready",
    phaseId: opts.phaseId,
    worktree: "none",
  };

  // Announce the task + start BEFORE running the session so the UI projection
  // creates the task entity and binds the forthcoming session_started event
  // (tagged with taskId by the engine) to it.
  opts.onStatus?.onTaskRegister?.({
    taskId: task.id,
    phaseId: opts.phaseId,
    title: task.title,
    dependencies: task.dependencies,
  });
  opts.onStatus?.onTaskStart?.({
    taskId: task.id,
    title: task.title,
    agentId: opts.agentId,
    phaseId: opts.phaseId,
    startedAt: Date.now(),
  });

  let sessionResult: SessionResult | undefined;
  const runnerCtx: RunnerContext = {
    task,
    gate,
    runSession: async (sctx: RunSessionContext): Promise<SessionResult> => {
      sessionResult = await runSession(sctx);
      return sessionResult;
    },
    profiles,
    sessionBaseDir: opts.sessionBaseDir,
    cwd: opts.cwd,
    ...(opts.apiKeys !== undefined ? { apiKeys: opts.apiKeys } : {}),
    activeSessions: new Set(),
    ...(opts.onStatus !== undefined ? { onStatus: opts.onStatus } : {}),
    ...(opts.hookRegistry !== undefined
      ? { hookRegistry: opts.hookRegistry }
      : {}),
    phaseId: opts.phaseId,
    agentId: opts.agentId,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  const runner = singleSession(spec);
  try {
    await runner(runnerCtx);
  } catch (err) {
    opts.onStatus?.onTaskRejected?.({
      taskId: task.id,
      title: task.title,
      reason: String(err),
    });
    throw err;
  }

  opts.onStatus?.onTaskComplete?.({ taskId: task.id, title: task.title });

  if (sessionResult?.mode === "structured") {
    return sessionResult.data as T;
  }
  return undefined;
}
