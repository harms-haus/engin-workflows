import type { StepDefinition } from "@harms-haus/engin-engine";
import { ReviewResultSchema } from "./schemas";

// ─── Step Definitions ───────────────────────────────────────────────────────

export const CODE_STEPS: readonly StepDefinition[] = Object.freeze([
    { name: 'write-tests', profileId: 'test-writer', isReadOnly: false },
    { name: 'review-tests', profileId: 'test-reviewer', isReadOnly: true, schema: ReviewResultSchema },
    { name: 'execute', profileId: 'implementer', isReadOnly: false },
    { name: 'review', profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
]);

export const NON_CODE_STEPS: readonly StepDefinition[] = Object.freeze([
    { name: 'execute', profileId: 'implementer', isReadOnly: false },
    { name: 'review', profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
]);
