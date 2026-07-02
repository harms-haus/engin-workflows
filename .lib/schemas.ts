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

/** How a planned task is executed. Replaces the former `is_code` boolean.
 *
 *  The mode selects the runner tree the implementation phase builds for the
 *  task (see `resolveImplementationRunner` in implementation.ts):
 *
 *  - `tests_and_code`  — TDD red→green. The red-team writes FAILING tests
 *    encoding the target behavior, then the green-team implements the
 *    production code to make them pass:
 *      linearRunner([
 *        reviewRunner(write-tests, review-tests),
 *        reviewRunner(write-code,  review-code),
 *      ])
 *  - `just_tests`      — only improve/extend the test suite on EXISTING code
 *    (strengthen assertions, add edge cases, write characterization tests,
 *    remove/rewrite tautological tests). No production code follows:
 *      reviewRunner(write-tests, review-tests)
 *    Here the tests should PASS against the current code.
 *  - `code_only`       — production code with NO separate test-writing phase.
 *    For mechanical fixes, dead-code removal, or changes already covered by
 *    existing tests, where a red-team test phase is pure overhead:
 *      reviewRunner(write-code, review-code)
 *  - `no_code_execution` — docs, config, comments, or other non-code work,
 *    with no test phase:
 *      reviewRunner(execute, review)
 */
export const TaskModeSchema = z.enum([
  "tests_and_code",
  "just_tests",
  "code_only",
  "no_code_execution",
]);
export type TaskMode = z.infer<typeof TaskModeSchema>;

export const PlanSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().describe("Unique task identifier"),
      title: z.string().describe("Short description of the task"),
      prompt: z.string().describe("Detailed prompt for the implementing agent"),
      profile: z.string().describe("Agent profile to use, e.g. 'implementer'"),
      files: z.array(z.string()).describe("Files this task will modify"),
      mode: TaskModeSchema.describe(
        "How this task runs. 'tests_and_code' = TDD red→green (write failing tests, then implement). 'just_tests' = improve/strengthen tests on existing code only (no production changes; tests should pass). 'code_only' = production code with no separate test-writing phase (mechanical fixes / already-covered changes). 'no_code_execution' = docs, config, comments, or other non-code work with no test phase.",
      ),
      dependencies: z
        .array(z.string())
        .describe("Task IDs that must complete first"),
    }),
  ),
  strategy: z.string().describe("High-level implementation strategy"),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = Plan["tasks"][number];

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

// ─── Retrospective Decision (post-fix re-assessment) ────────────────────
export const RetrospectiveDecisionSchema = z.object({
  terminate: z
    .boolean()
    .describe(
      "Set true when this dimension's review work is complete and clean (no actionable findings or regressions remain, no further fix round needed). Set false when there are still actionable findings or regressions requiring another fix round.",
    ),
  applicable: z
    .boolean()
    .describe(
      "false when this review dimension does not apply to the change (e.g. security review on a docs-only change) — put the reason in summary. When false, findings/resolvedFindings/regressions should be empty and terminate should be true.",
    ),
  summary: z
    .string()
    .describe(
      "Overall re-assessment after the fixes were applied: what you re-checked, whether prior findings were resolved, and your conclusion. Include the not-applicable reason here when applicable=false.",
    ),
  findings: z
    .array(FinalReviewFindingSchema)
    .describe(
      "Remaining actionable findings still OPEN after this round of fixes (severity >= medium), ordered by severity. These drive the next fix round. Empty when the dimension is clean.",
    ),
  resolvedFindings: z
    .array(FinalReviewFindingSchema)
    .describe(
      "Prior findings from earlier rounds that this round's fixes CONFIRMED resolved.",
    ),
  regressions: z
    .array(FinalReviewFindingSchema)
    .describe(
      "NEW findings introduced by the fixes themselves (regressions) — these must be addressed in the next round.",
    ),
});
export type RetrospectiveDecision = z.infer<typeof RetrospectiveDecisionSchema>;

export const TitleSchema = z.object({
  title: z.string().describe("A concise 3-8 word title summarizing the task"),
});

// ─── Producer done-signals ─────────────────────────────────────────────────
//
// Producing agents (planner, test-writer, implementer) run in STRUCTURED-OUTPUT
// mode against these schemas. This is a deliberate completion gate: the engine's
// `promptForStructured` re-prompts the SAME session (up to 3×) when the agent
// ends early — empty reply, no JSON, or schema-invalid — sending targeted
// "you ended on a tool call / fix your format" reminders each time.
//
// Without these signals the producing sessions ran in text/filesystem mode and
// could silently "succeed" after stopping prematurely (e.g. the planner ending
// before writing the plan), which only surfaced downstream when a reviewer
// rejected the empty work. The done-signal moves that detection to the source:
// the agent must self-certify it finished, or be re-prompted in the same
// session until it does.

/** Planner done-signal. `plan_ready: true` ONLY after the plan JSON file has
 *  been written to disk. Drives structured-output retries in the planning
 *  phase. */
export const PlanReadySchema = z.object({
  plan_ready: z
    .boolean()
    .describe(
      "Set to true ONLY after you have written the complete plan JSON file to disk. " +
        "Set to false if you genuinely cannot produce a plan.",
    ),
});
export type PlanReady = z.infer<typeof PlanReadySchema>;

/** Test-writer done-signal. `tests_ready: true` ONLY after the tests for the
 *  task have been written. Drives structured-output retries for the write-tests
 *  session of a code task. */
export const TestsReadySchema = z.object({
  tests_ready: z
    .boolean()
    .describe(
      "Set to true ONLY after you have written the tests for this task. " +
        "Set to false if you genuinely cannot write the tests.",
    ),
});
export type TestsReady = z.infer<typeof TestsReadySchema>;

/** Implementer done-signal. `implementation_done: true` ONLY after the task has
 *  been fully implemented. Drives structured-output retries for the execute
 *  session of an implementation task. */
export const ImplementationDoneSchema = z.object({
  implementation_done: z
    .boolean()
    .describe(
      "Set to true ONLY after you have fully implemented the task. " +
        "Set to false if you genuinely cannot complete it.",
    ),
});
export type ImplementationDone = z.infer<typeof ImplementationDoneSchema>;
