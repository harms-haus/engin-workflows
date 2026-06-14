import type { StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin";
import { createHarness, promptForStructured } from "@harms-haus/engin";
import { TitleSchema } from "./schemas";
import { makeHarnessOptions, spawnAgent } from "./helpers";

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
): Promise<string> {
    try {
        const opts = await makeHarnessOptions(profilesDirs, 'scout', cwd, 'title-generator', apiKeys, onStatus);
        const { session, dispose } = await createHarness(opts);
        spawnAgent(tracker, onStatus, { agentId: 'title-generator', profile: 'scout', phase: 'initialization' });

        const prompt = [
            'You are a title generator. Generate a concise 3-8 word title summarizing the following task.',
            '',
            `Task: ${taskPrompt}`,
            '',
            'Respond with a JSON object containing a "title" field with your concise title.',
        ].join('\n');

        let result: { title: string };
        try {
            ({ result } = await promptForStructured(session, prompt, TitleSchema));
        } finally {
            dispose?.();
        }
        onStatus?.onAgentComplete?.({ agentId: 'title-generator', profile: 'scout', phase: 'initialization' });

        return result.title;
    } catch (err: unknown) {
        // Fallback: truncate the task prompt to use as title
        return taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
    }
}
