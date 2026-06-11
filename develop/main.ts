// ─── Development Workflow ────────────────────────────────────────────────────
import { z } from "zod";
import type { AgentProfile, AgentStatusCallbacks, HarnessCreationOptions, StatusCallbacks, AuditEvent, StepDefinition } from "@harms-haus/engin";
import { loadProfilesFromDirs } from "@harms-haus/engin";
import { resolveProfilesDirs } from "@harms-haus/engin";
import { createHarness } from "@harms-haus/engin";
import { promptForStructured } from "@harms-haus/engin";
import { parallelAgents } from "@harms-haus/engin";
import { WorkflowStatusTracker, PHASE_ORDER } from "@harms-haus/engin";
import { LanePool } from "@harms-haus/engin";
import { join } from "node:path";

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

export const ScoutingReviewSchema = z.object({
    ready: z.boolean().describe("Whether enough information has been gathered to proceed"),
    research: z.string().describe("Synthesized research summary from the scouting reports"),
    gaps: z.array(z.string()).describe("Topics that still need investigation"),
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

// ─── Step Definitions ───────────────────────────────────────────────────────

const CODE_STEPS: StepDefinition[] = [
    { name: 'write-tests', profileId: 'test-writer', isReadOnly: false },
    { name: 'review-tests', profileId: 'test-reviewer', isReadOnly: true, schema: ReviewResultSchema },
    { name: 'execute', profileId: 'implementer', isReadOnly: false },
    { name: 'review', profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
];

const NON_CODE_STEPS: StepDefinition[] = [
    { name: 'execute', profileId: 'implementer', isReadOnly: false },
    { name: 'review', profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
];

// ─── Shared Options ─────────────────────────────────────────────────────────

export interface DevelopWorkflowOptions {
    /** Directory containing agent profile .md files */
    profilesDir?: string;
    /** Working directory for the project being developed */
    cwd: string;
    /** Maximum concurrent implementation tasks */
    maxConcurrentTasks?: number;
    /** Custom API keys by provider */
    apiKeys?: Record<string, string>;
    /** Status callbacks for agent/workflow events */
    onStatus?: StatusCallbacks;
    /** Existing workDir to resume from */
    workDir?: string;
    /** Abort signal for cooperative cancellation */
    signal?: AbortSignal;
    /** Pre-created tracker to use instead of creating a new one */
    tracker?: unknown;
}

// ─── Audit Event Helpers ─────────────────────────────────────────────────

function structuredOutputEvent(
    agentId: string,
    output: unknown,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "structured_output" }>, "timestamp"> {
    return { type: "structured_output", agentId, output, ...(taskId && { taskId }) };
}

function decisionEvent(
    agentId: string,
    decision: string,
    reasoning: string,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "decision" }>, "timestamp"> {
    return { type: "decision", agentId, decision, reasoning, ...(taskId && { taskId }) };
}

function errorEvent(
    agentId: string,
    error: string,
    taskId?: string,
): Omit<Extract<AuditEvent, { type: "error" }>, "timestamp"> {
    return { type: "error", agentId, error, ...(taskId && { taskId }) };
}

// ─── Helper: get profile and create harness ─────────────────────────────────

async function getProfile(
    profilesDirs: string[],
    profileId: string,
): Promise<AgentProfile> {
    const profiles = await loadProfilesFromDirs(profilesDirs);
    const profile = profiles.get(profileId);
    if (!profile) {
        throw new Error(`Profile "${profileId}" not found in ${profilesDirs.join(", ")}`);
    }
    return profile;
}

function agentCallbacks(onStatus?: StatusCallbacks): AgentStatusCallbacks | undefined {
    if (!onStatus) return undefined;
    return {
        onTurnStart: onStatus.onTurnStart,
        onTurnEnd: onStatus.onTurnEnd,
        onToolCallStart: onStatus.onToolCallStart,
        onToolCallEnd: onStatus.onToolCallEnd,
    };
}

async function makeHarnessOptions(
    profilesDirs: string[],
    profileId: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<HarnessCreationOptions> {
    const profile = await getProfile(profilesDirs, profileId);
    return { profile, cwd, apiKeys, onAgentStatus: agentCallbacks(onStatus) };
}

// ─── Phase type (shared by run(), completePhase, executePhase) ────────────

type Phase =
    | "scouting"
    | "scouting_review"
    | "planning"
    | "plan_review"
    | "implementing"
    | "final_review"
    | "done";

// ─── Sidebar Phase Metadata ────────────────────────────────────────────────

const SIDEBAR_PHASES = [
    { id: 'initialization',  label: 'Initialization',  icon: '⚙' },
    { id: 'scouting',        label: 'Scouting',        icon: '🔍' },
    { id: 'scouting_review', label: 'Scouting Review', icon: '🔎' },
    { id: 'planning',        label: 'Planning',        icon: '📋' },
    { id: 'plan_review',     label: 'Plan Review',     icon: '📝' },
    { id: 'implementing',    label: 'Implementing',    icon: '🔨' },
    { id: 'final_review',    label: 'Final Review',    icon: '🔎' },
];

function getPhaseIndicator(phase: Phase): string {
    const entry = SIDEBAR_PHASES.find(p => p.id === phase);
    return entry?.icon ?? '⏳';
}

/**
 * Mutable state shared across phase executions within a single `run()` call.
 * Passed by reference so `executePhase` mutations are visible to the caller.
 */
interface RunState {
    research: string;
    plan: Plan | undefined;
    scoutingReports: unknown[];
    scoutingRounds: number;
    planningRounds: number;
    planReviewFeedback?: string;
    planReviewSuggestions?: string[];
}

// ─── Helper: complete a phase transition ────────────────────────────────────

async function completePhase(
    phase: Phase,
    tracker: WorkflowStatusTracker,
    onStatus: StatusCallbacks | undefined,
    startTime: number,
    nextPhase?: Phase,
): Promise<void> {
    if (nextPhase !== undefined) {
        tracker.setPhase(nextPhase);
    } else {
        tracker.advancePhase();
    }
    await tracker.save();
    onStatus?.onPhaseComplete?.({ phase, durationMs: Date.now() - startTime });
}

// ─── Helper: execute a single pipeline phase ───────────────────────────────

/**
 * Execute a single pipeline phase.
 *
 * Each case does exactly ONE step. The caller (`run`) handles advancing
 * phases and looping back when needed (e.g. scouting retries). May return
 * the name of a phase to jump to instead of advancing linearly.
 */
async function executePhase(
    phase: Phase,
    state: RunState,
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    maxConcurrentTasks: number | undefined,
    workDir: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
): Promise<Phase | void> {
    const phaseStartTime = Date.now();
    const round = (phase === "scouting" || phase === "scouting_review")
        ? state.scoutingRounds
        : (phase === "planning" || phase === "plan_review")
            ? state.planningRounds
            : 0;
    onStatus?.onPhaseStart?.({ phase, round });
    onStatus?.onSidebarUpdate?.({ indicator: getPhaseIndicator(phase) });

    switch (phase) {
        // ── Scouting: run scouts, then advance to scouting_review ──
        case "scouting": {
            state.scoutingReports = await scoutingPhase(
                tracker, profilesDirs, taskPrompt, cwd, apiKeys, onStatus,
            );
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Scouting Review: evaluate reports, loop back if needed ──
        case "scouting_review": {
            const reports = state.scoutingReports.length > 0
                ? state.scoutingReports
                : tracker.scoutingReports;
            const review = await scoutingReviewPhase(
                tracker, profilesDirs, reports, cwd, apiKeys, onStatus,
            );
            state.scoutingRounds++;

            state.research = review.research;
            tracker.setResearch(state.research);

            if (review.ready) {
                await completePhase(phase, tracker, onStatus, phaseStartTime);
                break;
            }

            // Not ready — loop back to scouting (max 3 rounds)
            if (state.scoutingRounds < 3) {
                await completePhase(phase, tracker, onStatus, phaseStartTime, "scouting");
                return "scouting";
            }

            // Exhausted rounds — proceed anyway with what we have
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Planning: create a plan, then advance to plan_review ──
        case "planning": {
            // Derive research from saved scouting reports if not yet available
            if (!state.research) {
                if (tracker.research) {
                    state.research = tracker.research;
                } else {
                    const reports = tracker.scoutingReports;
                    const review = await scoutingReviewPhase(
                        tracker, profilesDirs, reports, cwd, apiKeys, onStatus,
                    );
                    state.research = review.research;
                    tracker.setResearch(state.research);
                }
            }

            state.plan = await planningPhase(
                tracker, profilesDirs, state.research, taskPrompt, cwd,
                state.planReviewFeedback, state.planReviewSuggestions,
                apiKeys, onStatus,
            );
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Plan Review: evaluate the plan, loop back if needed ──
        case "plan_review": {
            if (!state.plan) {
                state.plan = tracker.plan as Plan | undefined;
            }

            const planReview = await planReviewPhase(
                tracker, profilesDirs, state.plan!, state.research, taskPrompt, cwd, apiKeys, onStatus,
            );
            state.planningRounds++;

            if (planReview.ready) {
                state.planReviewFeedback = undefined;
                state.planReviewSuggestions = undefined;
                tracker.clearPlanReviewFeedback();
                await completePhase(phase, tracker, onStatus, phaseStartTime);
                break;
            }

            // Not ready — loop back to planning (max 3 rounds)
            state.planReviewFeedback = planReview.feedback;
            state.planReviewSuggestions = planReview.suggestions;
            tracker.setPlanReviewFeedback(planReview.feedback, planReview.suggestions);
            if (state.planningRounds < 3) {
                state.plan = undefined;
                await completePhase(phase, tracker, onStatus, phaseStartTime, "planning");
                return "planning";
            }

            // Exhausted rounds — proceed anyway with current plan
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Implementation: run the plan tasks ──
        case "implementing": {
            // Load plan from tracker on resume
            if (!state.plan) {
                state.plan = tracker.plan as Plan | undefined;
            }
            if (state.plan) {
                await implementationPhase(
                    tracker, profilesDirs, state.plan, cwd, maxConcurrentTasks, workDir, apiKeys, onStatus, signal,
                );
            }
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        // ── Final Review: quality check the result ──
        case "final_review": {
            await finalReviewPhase(tracker, profilesDirs, cwd, apiKeys, onStatus);
            await completePhase(phase, tracker, onStatus, phaseStartTime);
            break;
        }

        case "done":
            break;
    }
}

// ─── Phase 1: Scouting ──────────────────────────────────────────────────────

/**
 * Scout the codebase to identify key areas of investigation.
 *
 * 1. Uses the `scout` profile to identify topics.
 * 2. For each topic, spawns a scout agent in parallel to investigate.
 * 3. Returns the collected reports.
 */
export async function scoutingPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<unknown[]> {
    // 1. Get scouting topics
    const scoutOpts = await makeHarnessOptions(profilesDirs, "scout", cwd, apiKeys, onStatus);
    const { session: scoutHarness, dispose: scoutDispose } = await createHarness(scoutOpts);
    onStatus?.onAgentSpawn?.({ agentId: "scout-coordinator", profile: "scout", phase: "scouting" });
    tracker.recordAgentSpawn({ agentId: "scout-coordinator", profile: "scout", phase: "scouting" });
    tracker.incrementAgentCount();

    let topics: ScoutingTopics;
    try {
        const topicPrompt = [
            "You are a codebase scout. Analyze the task below and identify key areas of the codebase that need investigation.",
            "",
            `Task: ${taskPrompt}`,
        ].join("\n");

        topics = await promptForStructured(scoutHarness, topicPrompt, ScoutingTopicSchema);
    } finally {
        scoutDispose?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "scout-coordinator", profile: "scout", phase: "scouting" });

    // 2. Spawn parallel scouts for each topic
    const reports: unknown[] = [];

    if (topics.topics.length > 0) {
        for (let i = 0; i < topics.topics.length; i++) {
            onStatus?.onAgentSpawn?.({ agentId: `scout-${i}`, profile: "scout", phase: "scouting" });
            tracker.recordAgentSpawn({ agentId: `scout-${i}`, profile: "scout", phase: "scouting" });
            tracker.incrementAgentCount();
        }

        const scoutProfile = await getProfile(profilesDirs, "scout");
        const scoutConfigs: HarnessCreationOptions[] = topics.topics.map(() => ({
            profile: scoutProfile,
            cwd,
            apiKeys,
            onAgentStatus: agentCallbacks(onStatus),
        }));

        const results = await parallelAgents(
            scoutConfigs,
            (_harness, i) => {
                const topic = topics.topics[i];
                return [
                    `Investigate the following area of the codebase:`,
                    "",
                    `Topic: ${topic.topic}`,
                    `Rationale: ${topic.rationale}`,
                    `Key files: ${topic.files.join(", ")}`,
                    "",
                    "Provide a detailed report of your findings as a JSON object with a 'report' field.",
                ].join("\n");
            },
        );

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === "fulfilled") {
                reports.push(result.value);
                onStatus?.onAgentComplete?.({ agentId: `scout-${i}`, profile: "scout", phase: "scouting" });
            }
        }
    }

    // 3. Update tracker
    tracker.setScoutingReports(reports);

    await tracker.auditLog.append(
        structuredOutputEvent("scout-coordinator", topics),
    );

    return reports;
}

// ─── Phase 2: Scouting Review ───────────────────────────────────────────────

/**
 * Review the scouting reports and determine if we have enough information
 * to proceed to planning.
 */
export async function scoutingReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    reports: unknown[],
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<ScoutingReview> {
    const opts = await makeHarnessOptions(profilesDirs, "scouting-reviewer", cwd, apiKeys, onStatus);
    const { session: harness, dispose: unsub } = await createHarness(opts);
    onStatus?.onAgentSpawn?.({ agentId: "scouting-reviewer", profile: "scouting-reviewer", phase: "scouting_review" });
    tracker.recordAgentSpawn({ agentId: "scouting-reviewer", profile: "scouting-reviewer", phase: "scouting_review" });
    tracker.incrementAgentCount();

    const prompt = [
        "You are reviewing scouting reports to determine if we have enough information to create an implementation plan.",
        "",
        "Scouting reports:",
        JSON.stringify(reports, null, 2),
        "",
        "Determine if we're ready to plan. If not, identify what gaps remain.",
    ].join("\n");

    let review: ScoutingReview;
    try {
        review = await promptForStructured(harness, prompt, ScoutingReviewSchema);
    } finally {
        unsub?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "scouting-reviewer", profile: "scouting-reviewer", phase: "scouting_review" });

    onStatus?.onDecision?.({
        agentId: "scouting-reviewer",
        decision: review.ready ? "proceed_to_planning" : "more_scouting_needed",
        reasoning: review.research,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "scouting-reviewer",
            review.ready ? "proceed_to_planning" : "more_scouting_needed",
            review.research,
        ),
    );

    return review;
}

// ─── Phase 3: Planning ──────────────────────────────────────────────────────

/**
 * Create an implementation plan based on the scouting research and task prompt.
 */
export async function planningPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    research: string,
    taskPrompt: string,
    cwd: string,
    planReviewFeedback?: string,
    planReviewSuggestions?: string[],
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<Plan> {
    const opts = await makeHarnessOptions(profilesDirs, "planner", cwd, apiKeys, onStatus);
    const { session: harness, dispose: unsub } = await createHarness(opts);
    onStatus?.onAgentSpawn?.({ agentId: "planner", profile: "planner", phase: "planning" });
    tracker.recordAgentSpawn({ agentId: "planner", profile: "planner", phase: "planning" });
    tracker.incrementAgentCount();

    const promptLines: string[] = [
        "You are a planning agent. Based on the research below, create a detailed implementation plan.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research findings:",
        research,
        "",
        "Create a plan with specific tasks. Each task should be independently implementable.",
    ];

    if (planReviewFeedback) {
        promptLines.push(
            "",
            "Previous plan was rejected. Address the following feedback:",
            planReviewFeedback,
        );
        if (planReviewSuggestions && planReviewSuggestions.length > 0) {
            promptLines.push(
                "",
                "Specific suggestions:",
                ...planReviewSuggestions.map(s => `- ${s}`),
            );
        }
    }

    const prompt = promptLines.join("\n");

    let plan: Plan;
    try {
        plan = await promptForStructured(harness, prompt, PlanSchema);
    } finally {
        unsub?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "planner", profile: "planner", phase: "planning" });

    tracker.setPlan(plan);

    await tracker.auditLog.append(
        structuredOutputEvent("planner", plan),
    );

    return plan;
}

// ─── Phase 4: Plan Review ───────────────────────────────────────────────────

/**
 * Review the plan and determine if it's ready for implementation.
 */
export async function planReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    plan: Plan,
    research: string,
    taskPrompt: string,
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<PlanReview> {
    const opts = await makeHarnessOptions(profilesDirs, "plan-reviewer", cwd, apiKeys, onStatus);
    const { session: harness, dispose: unsub } = await createHarness(opts);
    onStatus?.onAgentSpawn?.({ agentId: "plan-reviewer", profile: "plan-reviewer", phase: "plan_review" });
    tracker.recordAgentSpawn({ agentId: "plan-reviewer", profile: "plan-reviewer", phase: "plan_review" });
    tracker.incrementAgentCount();

    const prompt = [
        "You are reviewing an implementation plan. Evaluate it for completeness, correctness, and feasibility.",
        "",
        `Task: ${taskPrompt}`,
        "",
        "Research context:",
        research,
        "",
        "Proposed plan:",
        JSON.stringify(plan, null, 2),
        "",
        "Approve the plan if it's sound, or provide specific feedback for improvement.",
    ].join("\n");

    let review: PlanReview;
    try {
        review = await promptForStructured(harness, prompt, PlanReviewSchema);
    } finally {
        unsub?.();
    }
    onStatus?.onAgentComplete?.({ agentId: "plan-reviewer", profile: "plan-reviewer", phase: "plan_review" });

    onStatus?.onDecision?.({
        agentId: "plan-reviewer",
        decision: review.ready ? "plan_approved" : "plan_rejected",
        reasoning: review.feedback,
    });

    await tracker.auditLog.append(
        decisionEvent(
            "plan-reviewer",
            review.ready ? "plan_approved" : "plan_rejected",
            review.feedback,
        ),
    );

    return review;
}

// ─── Phase 5: Implementation ────────────────────────────────────────────────

/**
 * Execute the implementation plan by:
 * 1. Loading tasks into the tracker
 * 2. Claiming and dispatching tasks to implementers
 * 3. Reviewing completed tasks
 * 4. Accepting or rejecting based on review
 */
export async function implementationPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    plan: Plan,
    cwd: string,
    maxConcurrentTasks: number = 3,
    workDir: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
    signal?: AbortSignal,
): Promise<void> {
    // 1. Load plan tasks into the tracker
    for (const task of plan.tasks) {
        if (!tracker.taskTracker.getTask(task.id)) {
            tracker.taskTracker.addTask({
                id: task.id,
                title: task.title,
                prompt: task.prompt,
                profile: task.profile,
                files: task.files,
                dependencies: task.dependencies,
                isCode: task.is_code,
            });
        }
    }

    // 2. Create and run the lane pool
    const pool = new LanePool({
        maxConcurrentLanes: maxConcurrentTasks,
        profilesDirs,
        sessionBaseDir: join(workDir, 'sessions'),
        cwd,
        apiKeys,
        onStatus,
        auditLog: tracker.auditLog,
        taskTracker: tracker.taskTracker,
        getStepsForTask: (task) => {
            const steps = task.isCode !== false ? CODE_STEPS : NON_CODE_STEPS;
            // If the task specifies a non-default implementer profile (e.g. 'implementer-lite'),
            // substitute it into the execute step while keeping reviewer steps unchanged.
            if (task.profile && task.profile !== 'implementer') {
                return steps.map(step =>
                    step.profileId === 'implementer'
                        ? { ...step, profileId: task.profile }
                        : step,
                );
            }
            return steps;
        },
        signal,
    });

    await pool.run();
}

// ─── Phase 6: Final Review ──────────────────────────────────────────────────

/**
 * Perform a final quality review of the entire implementation.
 * Spawns fixers for any issues found and loops until clean.
 */
export async function finalReviewPhase(
    tracker: WorkflowStatusTracker,
    profilesDirs: string[],
    cwd: string,
    apiKeys?: Record<string, string>,
    onStatus?: StatusCallbacks,
): Promise<boolean> {
    const maxFixRounds = 3;
    let clean = false;

    for (let round = 0; round < maxFixRounds; round++) {
        // 1. Get final review assessment
        const reviewerOpts = await makeHarnessOptions(profilesDirs, "final-reviewer", cwd, apiKeys, onStatus);
        const { session: reviewerHarness, dispose: reviewerDispose } = await createHarness(reviewerOpts);
        onStatus?.onAgentSpawn?.({ agentId: "final-reviewer", profile: "final-reviewer", phase: "final_review" });
        tracker.recordAgentSpawn({ agentId: "final-reviewer", profile: "final-reviewer", phase: "final_review" });
        tracker.incrementAgentCount();

        const reviewPrompt = [
            "You are performing a final quality review of the codebase.",
            "",
            "Examine the files and identify any remaining issues.",
        ].join("\n");

        let assessment: FinalReviewTopics;
        try {
            assessment = await promptForStructured(reviewerHarness, reviewPrompt, FinalReviewTopicsSchema);
        } finally {
            reviewerDispose?.();
        }
        onStatus?.onAgentComplete?.({ agentId: "final-reviewer", profile: "final-reviewer", phase: "final_review" });

        await tracker.auditLog.append(
            structuredOutputEvent("final-reviewer", assessment),
        );

        if (assessment.issues.length === 0) {
            clean = true;
            break;
        }

        // 2. Spawn fixers for critical issues
        const criticalIssues = assessment.issues.filter((issue) => issue.severity === "critical");
        if (criticalIssues.length === 0) {
            clean = true;
            break;
        }

        const fixerConfigs: HarnessCreationOptions[] = await Promise.all(
            criticalIssues.map(async () => {
                const profile = await getProfile(profilesDirs, "fixer");
                return { profile, cwd, apiKeys, onAgentStatus: agentCallbacks(onStatus) };
            }),
        );

        await parallelAgents(
            fixerConfigs,
            (_harness, i) => {
                const issue = criticalIssues[i];
                return [
                    "You are a fix agent. Resolve the following issue:",
                    "",
                    `File: ${issue.file}`,
                    `Issue: ${issue.description}`,
                    "",
                    "Apply the necessary fix.",
                ].join("\n");
            },
        );

        for (let i = 0; i < criticalIssues.length; i++) {
            onStatus?.onAgentSpawn?.({ agentId: `fixer-${i}`, profile: "fixer", phase: "final_review" });
            tracker.recordAgentSpawn({ agentId: `fixer-${i}`, profile: "fixer", phase: "final_review" });
            tracker.incrementAgentCount();
        }
    }

    return clean;
}

// ─── Initialization Phase ───────────────────────────────────────────────────

/**
 * Generate an AI title for the task using the scout profile.
 * Falls back to a truncated version of taskPrompt on any error.
 */
async function initializationPhase(
    profilesDirs: string[],
    taskPrompt: string,
    cwd: string,
    apiKeys: Record<string, string> | undefined,
    onStatus: StatusCallbacks | undefined,
    tracker: WorkflowStatusTracker,
): Promise<string> {
    try {
        const opts = await makeHarnessOptions(profilesDirs, 'scout', cwd, apiKeys, onStatus);
        const { session, dispose } = await createHarness(opts);
        onStatus?.onAgentSpawn?.({ agentId: 'title-generator', profile: 'scout', phase: 'initialization' });
        tracker.recordAgentSpawn({ agentId: 'title-generator', profile: 'scout', phase: 'initialization' });
        tracker.incrementAgentCount();

        const prompt = [
            'You are a title generator. Generate a concise 3-8 word title summarizing the following task.',
            '',
            `Task: ${taskPrompt}`,
            '',
            'Respond with a JSON object containing a "title" field with your concise title.',
        ].join('\n');

        let result: { title: string };
        try {
            result = await promptForStructured(session, prompt, TitleSchema);
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

// ─── Orchestrator: run ───────────────────────────────────────────────────────

export interface RunOptions extends DevelopWorkflowOptions {
    /** Directory to store workflow state */
    workDir: string;
}

/**
 * Run the full development workflow:
 * 1. Scouting (up to 3 rounds)
 * 2. Planning (up to 3 rounds)
 * 3. Implementation
 * 4. Final review
 */
export async function run(
    taskPrompt: string,
    options: RunOptions,
): Promise<void> {
    const { profilesDir, cwd, maxConcurrentTasks, apiKeys, workDir, onStatus, signal } = options;
    const profilesDirs: string[] = options.profilesDir ? [options.profilesDir] : resolveProfilesDirs(options.cwd, 'develop');
    const workflowStartTime = Date.now();

    // Create or load tracker (or reuse a passed-in one)
    let tracker: WorkflowStatusTracker;
    let resumed: boolean;
    if (options.tracker instanceof WorkflowStatusTracker) {
        tracker = options.tracker;
        // A passed tracker is "resumed" only if it has progress from a previous run
        resumed = tracker.completedPhases.length > 0;
    } else {
        try {
            tracker = await WorkflowStatusTracker.load(workDir);
            resumed = true;
        } catch (err: unknown) {
            const isNotFound =
                err instanceof Error && err.message.startsWith("Workflow state file not found");
            if (isNotFound) {
                tracker = new WorkflowStatusTracker(workDir);
                resumed = false;
            } else {
                throw err;
            }
        }
    }

    tracker.setTaskPrompt(taskPrompt);
    await tracker.save();

    onStatus?.onWorkflowStart?.({ taskPrompt, resumed, workDir });

    // ── Shared mutable state that flows between phases ────────────────
    const state: RunState = {
        research: tracker.research ?? "",
        plan: undefined,
        scoutingReports: [],
        scoutingRounds: 0,
        planningRounds: 0,
        planReviewFeedback: tracker.planReviewFeedback,
        planReviewSuggestions: tracker.planReviewSuggestions ? [...tracker.planReviewSuggestions] : undefined,
    };

    // ── Execute phases from the starting point ──────────────────────
    let currentIndex = PHASE_ORDER.indexOf(tracker.currentPhase as Phase);
    if (currentIndex < 0) currentIndex = 0;

    // ── Sidebar: initial phase metadata ─────────────────────────────
    // On resume, use truncated title and skip AI generation
    if (resumed) {
        const shortTitle = taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
        onStatus?.onSidebarUpdate?.({ title: shortTitle, indicator: getPhaseIndicator(PHASE_ORDER[currentIndex] as Phase), phases: SIDEBAR_PHASES });
    } else {
        // Run AI title generation before entering the main phase loop
        onStatus?.onSidebarUpdate?.({ title: 'Initializing...', indicator: '⚙', phases: SIDEBAR_PHASES });
        const title = await initializationPhase(profilesDirs, taskPrompt, cwd, apiKeys, onStatus, tracker);
        onStatus?.onSidebarUpdate?.({ title, indicator: getPhaseIndicator(PHASE_ORDER[currentIndex] as Phase) });
    }

    try {
        while (currentIndex < PHASE_ORDER.length) {
            const phase = PHASE_ORDER[currentIndex];
            if (phase === "done") break;

            // Check for cancellation before starting the next phase
            if (signal?.aborted) {
                throw new Error('Workflow cancelled');
            }

            const jumpTo = await executePhase(
                phase, state, tracker, profilesDirs, taskPrompt, cwd, maxConcurrentTasks, workDir, apiKeys, onStatus, signal,
            );

            if (jumpTo) {
                currentIndex = PHASE_ORDER.indexOf(jumpTo);
            } else {
                currentIndex++;
            }
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message === 'Workflow cancelled') {
            await tracker.save();
            onStatus?.onWorkflowFailed?.({ error: err, phase: tracker.currentPhase });
            return;
        }
        onStatus?.onWorkflowFailed?.({ error: err, phase: tracker.currentPhase });
        throw error;
    }

    onStatus?.onSidebarUpdate?.({ indicator: '✅' });
    onStatus?.onWorkflowComplete?.({ totalDurationMs: Date.now() - workflowStartTime, agentCount: tracker.stats.agentCount });
}
