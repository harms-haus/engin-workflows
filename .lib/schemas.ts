import { z } from "zod";

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const ScoutingTopicSchema = z.object({
    topics: z.array(
        z.object({
            topic: z.string().describe("Short name for the area to scout"),
            rationale: z.string().describe("Why this topic matters for the task"),
            files: z.array(z.string()).describe("Key files or directories to examine"),
        }),
    ),
});

export type ScoutingTopics = z.infer<typeof ScoutingTopicSchema>;

export const ScoutingGapSchema = z.object({
    topic: z.string().describe("Short name for the area that still needs scouting"),
    rationale: z.string().describe("Why this topic still needs investigation"),
    files: z.array(z.string()).describe("Key files or directories to examine"),
});

export type ScoutingGap = z.infer<typeof ScoutingGapSchema>;

export const ScoutingReviewSchema = z.object({
    ready: z.boolean().describe("Whether enough information has been gathered to proceed"),
    research: z.string().describe("Synthesized research summary from the scouting reports"),
    gaps: z.array(ScoutingGapSchema).describe(
        "Topics that still need investigation. Only include topics genuinely missing from the existing reports — do not repeat topics already covered.",
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
            is_code: z.boolean().describe("True if this task modifies code (requires test-first), false for docs/config/non-code tasks"),
            dependencies: z.array(z.string()).describe("Task IDs that must complete first"),
        }),
    ),
    strategy: z.string().describe("High-level implementation strategy"),
});

export type Plan = z.infer<typeof PlanSchema>;

export const PlanReviewSchema = z.object({
    ready: z.boolean().describe("Whether the plan is approved"),
    feedback: z.string().describe("Feedback or approval comments"),
    suggestions: z.array(z.string()).describe("Specific improvements if not ready"),
});

export type PlanReview = z.infer<typeof PlanReviewSchema>;

export const ReviewResultSchema = z.object({
    approved: z.boolean().describe("Whether the implementation is accepted"),
    feedback: z.string().describe("Detailed review feedback"),
    issues: z.array(
        z.object({
            file: z.string().describe("File with the issue"),
            description: z.string().describe("What needs to be fixed"),
            severity: z.enum(["critical", "minor"]).describe("How important the fix is"),
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

export const TitleSchema = z.object({ title: z.string().describe('A concise 3-8 word title summarizing the task') });
