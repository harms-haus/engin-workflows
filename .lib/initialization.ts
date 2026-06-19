import type { StatusCallbacks, WorkflowStatusTracker } from "@harms-haus/engin-engine";
import { runStepTask } from "@harms-haus/engin-engine";
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
): Promise<string> {
    try {
        const prompt = [
            'You are a title generator. Generate a concise 3-8 word title summarizing the following task.',
            '',
            `Task: ${taskPrompt}`,
            '',
            'Respond with a JSON object containing a "title" field with your concise title.',
        ].join('\n');

        const result = await runStepTask<{ title: string }>({
            profilesDirs,
            phaseId: 'initialization',
            taskId: 'title-generator',
            title: 'Title Generator',
            stepName: 'generate-title',
            profileId: 'scout',
            cwd,
            apiKeys,
            onStatus,
            isReadOnly: true,
            schema: TitleSchema,
            prompt,
        });

        return result.title;
    } catch (err: unknown) {
        // Fallback: truncate the task prompt to use as title
        return taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
    }
}
