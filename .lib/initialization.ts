import type {
    AgentProfile,
    RunSessionContext,
    StatusCallbacks,
    WorkflowStatusTracker,
} from "@harms-haus/engin-engine";
import { loadProfilesFromDirs, runSession, SessionGate } from "@harms-haus/engin-engine";
import { join } from "node:path";
import { TitleSchema } from "./schemas";

// ─── Initialization Phase ───────────────────────────────────────────────────

/**
 * Generate an AI title for the task using the scout profile.
 * Falls back to a truncated version of taskPrompt on any error.
 */
export async function initializationPhase(
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    apiKeys: Record<string, string> | undefined,
    onStatus: StatusCallbacks | undefined,
    tracker: WorkflowStatusTracker,
    /**
     * Run directory. When provided, the title-generation session is persisted
     * to `{workDir}/sessions/initialization` for traceability; when absent
     * (e.g. unit tests), an in-memory session is used.
     */
    workDir?: string,
): Promise<string> {
    // Title generation is a META concern: it runs OUT-OF-PHASE (no RunnerPool,
    // no TaskTracker), invisible to the task UI, with no worktree. A dedicated
    // SessionGate({ total: 1, perModel: {} }) admits exactly one title-gen
    // session at a time and runSession executes it as a single read-only
    // structured-output session.
    const gate = new SessionGate({ total: 1, perModel: {} });

    try {
        // 1. Resolve the scout profile used for title generation.
        const profiles = await loadProfilesFromDirs(profilesDirs);
        const profile = profiles.get('scout');
        // gate.run keys concurrency off { provider, model }. When the scout
        // profile is not configured (e.g. unit tests with no profile dirs),
        // fall back to a conservative default so title-generation proceeds.
        const gateProfile: AgentProfile =
            profile ??
            ({
                id: 'scout',
                name: 'scout',
                provider: 'anthropic',
                model: 'claude-sonnet-4',
                thinkingLevel: 'medium',
                systemPrompt: '',
                excludeTools: [],
                includeTools: [],
            } satisfies AgentProfile);

        // 2. Build the title-generation prompt.
        const prompt = [
            'You are a title generator. Generate a concise 3-8 word title summarizing the following task.',
            '',
            `Task: ${taskPrompt}`,
            '',
            'Respond with a JSON object containing a "title" field with your concise title.',
        ].join('\n');

        // 3. Build the out-of-phase session spec (read-only, structured output).
        const spec: RunSessionContext['spec'] = {
            id: 'title-generator',
            profile: 'scout',
            prompt,
            schema: TitleSchema,
            outputMode: 'structured',
            isReadOnly: true,
            runnerRole: 'title-gen',
            attempt: 1,
        };

        // Derive a session base dir. When a workDir is provided the title-gen
        // session is persisted to `{workDir}/sessions/initialization` for
        // traceability; otherwise it lands under the cwd.
        const sessionBaseDir = workDir
            ? join(workDir, 'sessions', 'initialization')
            : join(cwd, '.engin', 'sessions', 'initialization');

        // 4. Run the session under the gate (RAII single in-flight session).
        const result = await gate.run(gateProfile, async (handle) =>
            runSession({
                spec,
                sessionBaseDir,
                cwd,
                phaseId: 'initialization',
                agentId: 'title-generator',
                profiles,
                apiKeys,
                onStatus,
                activeSessions: new Set(),
                signal: handle.signal,
            }),
        );

        // 5. Extract the title from the structured result.
        if (result.mode === 'structured') {
            const data = result.data as { title?: string; branchName?: string };
            if (typeof data.title === 'string' && data.title.length > 0) {
                return data.title;
            }
        }
        // No usable structured title → fall through to the truncated-prompt fallback.
        return taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
    } catch (err: unknown) {
        // Fallback: truncate the task prompt to use as title
        return taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
    }
}
