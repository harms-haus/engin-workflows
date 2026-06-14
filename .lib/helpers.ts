import type { AgentProfile, HarnessCreationOptions, StatusCallbacks, WorkflowStatusTracker, AuditEvent } from "@harms-haus/engin";
import { loadProfilesFromDirs, forwardAgentStatus } from "@harms-haus/engin";

// ─── Audit Event Helpers ─────────────────────────────────────────────────

export function structuredOutputEvent(
    agentId: string,
    output: unknown,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "structured_output" }>, "timestamp"> {
    return { type: "structured_output", agentId, output, ...(taskId && { taskId }) };
}

export function decisionEvent(
    agentId: string,
    decision: string,
    reasoning: string,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "decision" }>, "timestamp"> {
    return { type: "decision", agentId, decision, reasoning, ...(taskId && { taskId }) };
}

export function errorEvent(
    agentId: string,
    error: string,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "error" }>, "timestamp"> {
    return { type: "error", agentId, error, ...(taskId && { taskId }) };
}

// ─── Helper: get profile and create harness ─────────────────────────────────
export async function getProfile(
    profilesDirs: string[],
    profileId: string,
): Promise<AgentProfile> {
    const profiles = await loadProfilesFromDirs(profilesDirs);
    const profile = profiles.get(profileId);
    if (!profile) {
        throw new Error(`Profile "${profileId}" not found in ${profilesDirs.join(", ")}`);
    }
    return profile;
}

export async function makeHarnessOptions(
    profilesDirs: string[],
    profileId: string,
    cwd: string,
    agentId: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<HarnessCreationOptions> {
    const profile = await getProfile(profilesDirs, profileId);
    return { profile, cwd, apiKeys, agentId, onAgentStatus: forwardAgentStatus(onStatus) };
}

// ─── Helper: track an agent spawn ─────────────────────────────────────────
//
// Single source of truth for the 3-line spawn-tracking pattern (projection +
// tracker + counter). Passing `info` once guarantees the onAgentSpawn payload
// and tracker record cannot diverge.

export interface SpawnInfo {
    agentId: string;
    profile: string;
    phaseId: string;
    taskId?: string;
}

export function spawnAgent(
    tracker: WorkflowStatusTracker,
    onStatus: StatusCallbacks | undefined,
    info: SpawnInfo,
): void {
    onStatus?.onAgentSpawn?.(info);
    tracker.recordAgentSpawn(info);
    tracker.incrementAgentCount();
}
