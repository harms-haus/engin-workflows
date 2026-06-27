import { z } from "zod";

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const ScoutingTopicSchema = z.object({
  topics: z.array(
    z.object({
      topic: z.string().describe("Short name for the area to scout"),
      rationale: z.string().describe("Why this topic matters for the task"),
      files: z
        .array(z.string())
        .describe("Key files or directories to examine"),
    }),
  ),
});

export type ScoutingTopics = z.infer<typeof ScoutingTopicSchema>;

export const ScoutingGapSchema = z.object({
  topic: z
    .string()
    .describe("Short name for the area that still needs scouting"),
  rationale: z.string().describe("Why this topic still needs investigation"),
  files: z.array(z.string()).describe("Key files or directories to examine"),
});

export type ScoutingGap = z.infer<typeof ScoutingGapSchema>;

export const ScoutingReviewSchema = z.object({
  ready: z
    .boolean()
    .describe("Whether enough information has been gathered to proceed"),
  research: z
    .string()
    .describe("Synthesized research summary from the scouting reports"),
  gaps: z
    .array(ScoutingGapSchema)
    .describe(
      "Topics that still need investigation. Only include topics genuinely missing from the existing reports — do not repeat topics already covered.",
    ),
  files: z
    .array(z.string())
    .default([])
    .describe(
      "The key files a planner must open and read to write a precise implementation plan for THIS task. " +
        "Aggregate the most important concrete files surfaced across the scouting reports (prefer specific file paths over bare directories), de-duplicate, and order by importance. " +
        "Include ONLY files a planner would actually need to look at — do not pad the list. Empty array if no particular files are central to the task.",
    ),
});

export type ScoutingReview = z.infer<typeof ScoutingReviewSchema>;

export const PlanSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().describe("Unique task identifier"),
      title: z.string().describe("Short description of the task"),
      prompt: z.string().describe("Detailed prompt for the implementing agent"),
      profile: z.string().describe("Agent profile to use, e.g. 'implementer'"),
      files: z.array(z.string()).describe("Files this task will modify"),
      is_code: z
        .boolean()
        .describe(
          "True if this task modifies code (requires test-first), false for docs/config/non-code tasks",
        ),
      dependencies: z
        .array(z.string())
        .describe("Task IDs that must complete first"),
    }),
  ),
  strategy: z.string().describe("High-level implementation strategy"),
});

export type Plan = z.infer<typeof PlanSchema>;

export const PlanReviewSchema = z.object({
  approved: z.boolean().describe("Whether the plan is approved"),
  feedback: z
    .string()
    .describe(
      "Feedback or approval comments. When not approved, include specific suggestions for improvement.",
    ),
});

export type PlanReview = z.infer<typeof PlanReviewSchema>;

export const ReviewResultSchema = z.object({
  approved: z.boolean().describe("Whether the implementation is accepted"),
  feedback: z.string().describe("Detailed review feedback"),
  issues: z.array(
    z.object({
      file: z.string().describe("File with the issue"),
      description: z.string().describe("What needs to be fixed"),
      severity: z
        .enum(["critical", "minor"])
        .describe("How important the fix is"),
    }),
  ),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const FinalReviewTopicsSchema = z.object({
  topics: z.array(
    z.object({
      topic: z.string().describe("Area to review"),
      files: z.array(z.string()).describe("Files to examine"),
    }),
  ),
  overallAssessment: z.string().describe("General quality assessment"),
  issues: z.array(
    z.object({
      file: z.string(),
      description: z.string(),
      severity: z.enum(["critical", "minor"]),
    }),
  ),
});

export type FinalReviewTopics = z.infer<typeof FinalReviewTopicsSchema>;

// ─── Multi-Dimensional Final Review (replaces the single final-reviewer) ─────
//
// The final review now runs several specialized reviewers in parallel
// (efficiency, code-quality, ui-ux, security). Each produces a
// FinalReviewResult. Findings rated medium or higher are fed to the fixer
// LanePool; low-severity findings are recorded but do not trigger fixes.

export const FinalReviewSeveritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type FinalReviewSeverity = z.infer<typeof FinalReviewSeveritySchema>;

export const FinalReviewFindingSchema = z.object({
  id: z
    .string()
    .describe(
      "Short stable kebab-case identifier, unique within this review (e.g. 'n-plus-one-user-query')",
    ),
  severity: FinalReviewSeveritySchema.describe(
    "low = nit/cosmetic, medium = should fix, high = important, critical = must fix before merge",
  ),
  file: z
    .string()
    .describe(
      "Primary file the finding relates to, with line range if helpful (e.g. 'src/auth.ts:42-58')",
    ),
  title: z.string().describe("Concise one-line summary of the finding"),
  description: z
    .string()
    .describe(
      "Detailed explanation: what is wrong, why it matters, and the intended correct behavior",
    ),
  fixPrompt: z
    .string()
    .describe(
      "A complete, self-contained prompt that a fixer agent can execute directly to resolve this finding. " +
        "Must state the file(s), the exact problem, and the intended fix. Do not reference other findings.",
    ),
});
export type FinalReviewFinding = z.infer<typeof FinalReviewFindingSchema>;

export const FinalReviewResultSchema = z.object({
  dimension: z
    .string()
    .describe(
      "The review dimension you assessed (must match the dimension assigned in the prompt)",
    ),
  applicable: z
    .boolean()
    .describe(
      "false when this review dimension does not apply to the changeset (e.g. a UI/UX review with no UI changes). " +
        "When false, set notApplicableReason and return an empty findings array.",
    ),
  notApplicableReason: z
    .string()
    .describe(
      "Required when applicable=false. Explain why this dimension is irrelevant to the current changes. Empty string when applicable=true.",
    ),
  summary: z
    .string()
    .describe(
      "Overall assessment for this dimension (what you checked and your conclusion)",
    ),
  findings: z
    .array(FinalReviewFindingSchema)
    .describe(
      "Findings ordered by severity, most severe first. Empty when applicable=false or when there are genuinely no issues.",
    ),
});
export type FinalReviewResult = z.infer<typeof FinalReviewResultSchema>;

export const TitleSchema = z.object({
  title: z.string().describe("A concise 3-8 word title summarizing the task"),
});
