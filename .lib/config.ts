import type { StepDefinition, WorkflowRunOptions } from "@harms-haus/engin";

// ─── Workflow Configuration ─────────────────────────────────────────────────
//
// Encodes the differences between SPIR workflows (develop / improve / debug) as
// DATA, not boolean flags. Each workflow supplies its own WorkflowConfig; the
// shared backbone reads from it to drive behaviour.

export interface WorkflowConfig {
    name: string;
    defaultMaxConcurrentTasks: number;
    fixerSteps: StepDefinition[];
    sidebarPhases: { id: string; label: string; icon: string }[];
    titleFormatter: (description: string) => string;
}

// ─── Run Options ────────────────────────────────────────────────────────────

export interface SpirRunOptions extends WorkflowRunOptions {
    /** Preferred: list of profile directories to load agent profiles from. */
    profilesDirs?: string[];
    /** Legacy singular form; normalized to `profilesDirs: [profilesDir]` by `normalizeOptions`. */
    profilesDir?: string;
}

// ─── Options Normalization ─────────────────────────────────────────────────

/**
 * Return a NEW `SpirRunOptions` with `profilesDirs` resolved and the legacy
 * singular `profilesDir` stripped. `profilesDirs` takes precedence; otherwise
 * a singular `profilesDir` (if present) is wrapped in an array. The input is
 * never mutated and no `any` cast is involved.
 */
export function normalizeOptions(options: SpirRunOptions): SpirRunOptions {
    const { profilesDir, profilesDirs, ...rest } = options;
    const resolved = profilesDirs ?? (profilesDir ? [profilesDir] : undefined);
    return resolved ? { ...rest, profilesDirs: resolved } : rest;
}
