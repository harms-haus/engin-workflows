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

  let sessionResult: SessionResult | undefined;
  const runnerCtx: RunnerContext = {
    task: {
      id: opts.taskId,
      title: opts.taskTitle,
      prompt: spec.prompt,
      profile: spec.profile,
      files: [],
      dependencies: [],
      status: "ready",
      phaseId: opts.phaseId,
    } satisfies Task,
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
  await runner(runnerCtx);

  if (sessionResult?.mode === "structured") {
    return sessionResult.data as T;
  }
  return undefined;
}
