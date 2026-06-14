// ─── Development Workflow ────────────────────────────────────────────────────
import { runSpir, type SpirRunOptions, normalizeOptions } from '../.lib/spir';
import type { StepDefinition } from '@harms-haus/engin';

// Re-export everything from the SPIR backbone (schemas, phase fns, types, etc.)
export * from '../.lib/spir';

// ─── Workflow-specific Config ───────────────────────────────────────────────

export const workflowConfig = {
    name: 'develop' as const,
    defaultMaxConcurrentTasks: 5,
    fixerSteps: [
        { name: 'fix', profileId: 'fixer', isReadOnly: false },
    ] as StepDefinition[],
    sidebarPhases: [
        { id: 'initialization', label: 'Initialization', icon: '⚙' },
        { id: 'scouting', label: 'Scouting', icon: '🔍' },
        { id: 'planning', label: 'Planning', icon: '📋' },
        { id: 'implementing', label: 'Implementing', icon: '🔨' },
        { id: 'review', label: 'Review', icon: '🔎' },
    ],
    titleFormatter: (d: string) => d.slice(0, 100),
};

// ─── Types ──────────────────────────────────────────────────────────────────

export type DevelopWorkflowOptions = SpirRunOptions;

export interface RunOptions extends DevelopWorkflowOptions {
    workDir: string;
}

// ─── Entry Point ────────────────────────────────────────────────────────────

export async function run(taskPrompt: string, options: RunOptions): Promise<void> {
    return runSpir(workflowConfig, taskPrompt, normalizeOptions(options));
}
