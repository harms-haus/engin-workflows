// ─── Development Workflow ────────────────────────────────────────────────────
import { runSpir, type SpirRunOptions, type FinalReviewerConfig, normalizeOptions } from '../.lib/spir';
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
    finalReviewers: [
        { profileId: 'efficiency-reviewer', dimension: 'efficiency', label: 'Efficiency' },
        { profileId: 'code-quality-reviewer', dimension: 'code-quality', label: 'Code Quality' },
        { profileId: 'ui-ux-reviewer', dimension: 'ui-ux', label: 'UI/UX' },
        { profileId: 'security-reviewer', dimension: 'security', label: 'Security' },
    ] as FinalReviewerConfig[],
    phases: [
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
