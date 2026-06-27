// ─── Debug Workflow ─────────────────────────────────────────────────────────
import {
  runSpir,
  type SpirRunOptions,
  type FinalReviewerConfig,
  normalizeOptions,
  ReviewResultSchema,
} from "../.lib/spir";
import type { StepDefinition } from "@harms-haus/engin-engine";

// Re-export everything from the SPIR backbone (schemas, phase fns, types, etc.)
export * from "../.lib/spir";

// ─── Workflow-specific Config ───────────────────────────────────────────────

export const workflowConfig = {
  name: "debug" as const,
  defaultMaxConcurrentSessions: 20,
  modelConcurrency: {
    "zai:glm-5.2": 5,
    "zai:glm-5.1": 5,
    "opencode-go:deepseek-v4-flash": 5,
    "opencode-go:mimo-2.5": 5,
  },
  fixerSteps: [
    { name: "fix", profileId: "fixer", isReadOnly: false },
    {
      name: "verify",
      profileId: "fixer-reviewer",
      isReadOnly: true,
      schema: ReviewResultSchema,
    },
  ] as StepDefinition[],
  finalReviewers: [
    {
      profileId: "efficiency-reviewer",
      dimension: "efficiency",
      label: "Efficiency",
    },
    {
      profileId: "code-quality-reviewer",
      dimension: "code-quality",
      label: "Code Quality",
    },
    { profileId: "ui-ux-reviewer", dimension: "ui-ux", label: "UI/UX" },
    {
      profileId: "security-reviewer",
      dimension: "security",
      label: "Security",
    },
    {
      profileId: "documentation-reviewer",
      dimension: "documentation",
      label: "Documentation",
    },
  ] as FinalReviewerConfig[],
  phases: [
    { id: "scouting", label: "Scouting", icon: "🔍" },
    { id: "planning", label: "Planning", icon: "📋" },
    { id: "implementing", label: "Implementing", icon: "🔨" },
    { id: "review", label: "Review", icon: "🔎" },
  ],
  titleFormatter: (d: string) => d.slice(0, 100),
};

// ─── Types ──────────────────────────────────────────────────────────────────

export type DebugWorkflowOptions = SpirRunOptions;

export interface RunOptions extends DebugWorkflowOptions {
  workDir: string;
}

// ─── Entry Point ────────────────────────────────────────────────────────────

export async function run(
  taskPrompt: string,
  options: RunOptions,
): Promise<void> {
  return runSpir(workflowConfig, taskPrompt, normalizeOptions(options));
}
