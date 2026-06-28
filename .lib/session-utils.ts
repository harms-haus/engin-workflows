import type {
  RunSessionContext,
  SessionResult,
  SessionSpec,
  StatusCallbacks,
  Task,
  WorkflowRunOptions,
} from "@harms-haus/engin-engine";
import { loadProfilesFromDirs, runSession } from "@harms-haus/engin-engine";

// ─── runSingleSessionStructured helper ──────────────────────────────────────
//
// Run a single structured-output session via the session primitive (`runSession`),
// capturing the structured `SessionResult` directly from its return value.
//
// In the SessionPlan-contract engine, `singleSession` returns a
// SessionPlanFactory (() => SessionPlanRunner) — a planning/scheduling
// abstraction owned by the SessionScheduler. For a one-shot structured session
// outside the scheduler (scout-coordinator, scouting-reviewer, planner, etc.)
// we bypass the runner indirection entirely and call `runSession` directly,
// constructing the full SessionSpec (with deterministic id) and
// RunSessionContext ourselves.
//
// Returns the parsed structured data, or `undefined` when the session did not
// produce structured output.
//
// Task lifecycle: this helper emits the full task-lifecycle status callbacks
// (onTaskRegister / onTaskStart / onTaskComplete|onTaskRejected) so the TUI/web
// — which is event-sourced — can display the session as a real, owned task.
// It does NOT register the task in any shared TaskGraph. The graph is the
// SessionScheduler's work queue; inserting a meta-task there would pollute it
// (the scheduler would later claim and mis-run it). Events are sufficient for
// the UI projection.

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

  // Build the full SessionSpec with the deterministic id convention used by
  // singleSession: `${taskId}/${role}#${attempt}`.
  const attempt = spec.attempt;
  const fullSpec: SessionSpec = {
    id: `${opts.taskId}/${spec.role}#${attempt}`,
    profile: spec.profile,
    prompt: spec.prompt,
    outputMode: spec.outputMode,
    runnerRole: spec.role,
    attempt,
    ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
    ...(spec.isReadOnly !== undefined ? { isReadOnly: spec.isReadOnly } : {}),
  };

  // The task is used for status-callback identity (onTaskRegister/onTaskStart/
  // onTaskComplete) so the UI projection binds the forthcoming session_started
  // event (tagged with taskId by the engine) to this meta-task.
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

  const sessionCtx: RunSessionContext = {
    spec: fullSpec,
    sessionBaseDir: opts.sessionBaseDir,
    cwd: opts.cwd,
    phaseId: opts.phaseId,
    agentId: opts.agentId,
    taskId: opts.taskId,
    ...(opts.apiKeys !== undefined ? { apiKeys: opts.apiKeys } : {}),
    ...(opts.onStatus !== undefined ? { onStatus: opts.onStatus } : {}),
    activeSessions: new Set(),
    profiles,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  let sessionResult: SessionResult;
  try {
    sessionResult = await runSession(sessionCtx);
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
