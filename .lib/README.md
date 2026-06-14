# `.lib/` — SPIR Backbone

The shared, stateless, config-driven backbone for the **develop**, **improve**, and
**debug** workflows. Each workflow is a ~40-line thin wrapper (`{workflow}/main.ts`)
that supplies a [`WorkflowConfig`](#workflowconfig-parameterization) and delegates to
`runSpir`. All phase logic lives in the `.lib` modules documented here.

> **SPIR** = **S**couting → **P**lanning → **I**mplementation → **R**eview, plus a
> terminal `done` phase.

---

## Contents

- [Overview](#overview)
- [The SPIR Phase Loop](#the-spir-phase-loop)
- [WorkflowConfig Parameterization](#workflowconfig-parameterization)
- [The `run` / `runSpir` Contract](#the-run--runspir-contract)
- [SpirRunOptions & normalizeOptions](#spirrunoptions--normalizeoptions)
- [Profiles as the Behavioral Differentiator](#profiles-as-the-behavioral-differentiator)
- [Phase Module Reference](#phase-module-reference)
- [Resumption](#resumption)

---

## Overview

`.lib/` implements the SPIR model as a phase pipeline. It owns:

1. **Phase ordering** — the `PHASES` constant and the `Phase` union type.
2. **Phase-transition helper** — `completePhase`.
3. **Per-phase dispatcher** — `executePhase` (a `switch` over `Phase`).
4. **Top-level orchestrator** — `runSpir`, the single entry point thin wrappers call.

Everything else — the actual scouting, planning, implementation, and review logic —
lives in the sibling phase modules (`scouting.ts`, `planning.ts`, `implementation.ts`,
`final-review.ts`, `initialization.ts`).

Each workflow module imports the backbone via a relative path:

```ts
import { runSpir, type SpirRunOptions, normalizeOptions } from '../.lib/spir';
export * from '../.lib/spir';
```

Each workflow's `tsconfig.json` includes `../.lib/**/*.ts`, so the backbone is compiled
alongside the wrapper.

The backbone does **not** create a TUI. It consumes a pre-wired `onStatus: StatusCallbacks`
object that the engine composes from its EventStore + UI bridge before calling `runSpir`.
See the engine docs for `StatusCallbacks` and `EventStore`.

---

## The SPIR Phase Loop

### Phase order

```ts
export const PHASES: readonly Phase[] = ["scouting", "planning", "implementing", "review", "done"];

export type Phase = "scouting" | "planning" | "implementing" | "review" | "done";
```

### Dispatch model

`runSpir` iterates `PHASES` by index and calls `executePhase(phase, state, ctx)` for each.
`executePhase` does **exactly one step** per invocation and may return a `Phase` to jump to
instead of advancing linearly. This is how retry loops work — the caller, not the phase
function, controls progression:

```ts
const jumpTo = await executePhase(phase, state, ctx);
if (jumpTo) {
    currentIndex = PHASES.indexOf(jumpTo);   // non-linear jump (e.g. retry)
} else {
    currentIndex++;                           // linear advance
}
```

Before each phase, `runSpir` checks `signal?.aborted` and throws `"Workflow cancelled"` if set.

### Phase progression

```
scouting ──────▶ planning ──────▶ implementing ──────▶ review ──────▶ done
   │  ↺ ≤3         │  ↺ ≤3                                   │
   └───────────────┘                                         │
                                                              ▼
                                                          (fixer loop ≤3 rounds)
```

**Scouting** (`scouting.ts`) — up to **3 rounds**:

1. **Round 0 (first):** The `scout-coordinator` agent analyzes the task and produces a
   list of topics (each with a rationale and key files). These become scout tasks.
2. **Follow-up rounds:** Topics come directly from the previous review's gaps — the
   `scout-coordinator` is skipped (`phaseOptions.topics` is set).
3. All topics run in parallel as read-only `scout` tasks through the engine's `LanePool`.
   New reports are **appended** to the accumulated list across rounds.
4. The `scouting-reviewer` agent evaluates the combined reports and returns `{ ready, research, gaps }`.
   - If `ready` → advance to planning.
   - If not ready and `scoutingRounds < 3` → jump back to `"scouting"` using the gaps as new topics.
   - If 3 rounds exhausted → proceed anyway with current research.

**Planning** (`planning.ts`) — up to **3 rounds**:

1. The `planner` agent produces a structured `Plan` (strategy + tasks) from the research and task prompt.
   If this is a retry, the previous plan-review feedback and suggestions are injected into the prompt.
2. The `plan-reviewer` agent evaluates the plan and returns `{ ready, feedback, suggestions }`.
   - If `ready` → advance to implementation.
   - If not ready and `planningRounds < 3` → clear the plan and jump back to `"planning"`.
   - If 3 rounds exhausted → proceed with the current plan.

**Implementation** (`implementation.ts`):

1. Plan tasks are loaded into the shared `WorkflowStatusTracker.taskTracker` (skipping IDs already present).
2. Dependencies are validated (`validateAllDependencies()`).
3. A `LanePool` runs all tasks in parallel (bounded by `maxConcurrentTasks`). Each task's step sequence
   is determined by `getStepsForTask`: code tasks use `CODE_STEPS` (test-first), non-code tasks use
   `NON_CODE_STEPS`. If a task specifies a non-default `profile` (e.g. `implementer-lite`), that profile
   replaces `implementer` in the `execute` step while reviewer steps stay unchanged.
4. After the pool settles, a defense-in-depth check warns if settled task count ≠ total tasks.

**Review** (`final-review.ts`) — multi-dimensional review + fixer loop, up to **3 rounds**:

1. Several specialized reviewers run **in parallel** every round (by default, from `config.finalReviewers`:
   `efficiency-reviewer`, `code-quality-reviewer`, `ui-ux-reviewer`, `security-reviewer`). Each returns a
   `FinalReviewResult` — `{ dimension, applicable, notApplicableReason, summary, findings[] }`. A reviewer
   whose dimension is irrelevant to the changeset returns `applicable: false` with empty findings.
2. Each finding carries a severity (`low | medium | high | critical`) and a self-contained `fixPrompt`.
3. Findings rated **medium / high / critical** are collected across all applicable reviewers and spawn one
   `fixer` task each (via `LanePool`, using `config.fixerSteps`). `low` findings are recorded but do not fix.
4. If there are no actionable findings → clean, done. Otherwise the fixers run, then the reviewers run again.
   On every round each reviewer receives **its own complete prior-round history** (not just the latest
   round), so it can tell which findings were already addressed and avoid re-reporting fixed items.
5. After 3 rounds with persistent actionable findings, the phase returns `clean = false`.

> **Note:** The `initialization` phase (AI title generation) runs *before* the main loop in
> `runSpir`, not inside `executePhase`. See [initialization.ts](#initializationts).

---

## WorkflowConfig Parameterization

Defined in `config.ts`. This is the **sole code-level differentiator** between workflows.
The behavioral personality of each workflow comes from its [profile files](#profiles-as-the-behavioral-differentiator),
not from code branches.

```ts
export interface WorkflowConfig {
    name: string;
    defaultMaxConcurrentTasks: number;
    fixerSteps: StepDefinition[];
    finalReviewers?: FinalReviewerConfig[];   // specialized reviewers run in the final review
    phases: { id: string; label: string; icon: string }[];
    titleFormatter: (description: string) => string;
}

export interface FinalReviewerConfig {
    profileId: string;   // agent profile to load for this reviewer
    dimension: string;   // stable key used to bucket review history across rounds
    label: string;       // human-readable label shown in task titles / status
}
```

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Workflow identifier; used by `resolveProfilesDirs` to find the default profile directory |
| `defaultMaxConcurrentTasks` | `number` | Fallback concurrency when `options.maxConcurrentTasks` is not provided |
| `fixerSteps` | `StepDefinition[]` | Step sequence passed to the fixer `LanePool` in the final review |
| `finalReviewers` | `FinalReviewerConfig[]?` | Specialized reviewers run in parallel each final-review round; defaults to efficiency / code-quality / ui-ux / security |
| `phases` | `{ id, label, icon }[]` | Sidebar UI metadata; `getPhaseIndicator` resolves a phase → icon |
| `titleFormatter` | `(description: string) => string` | Formats fixer task titles from finding titles |

### Config differences across workflows

| | `develop` | `improve` | `debug` |
|---|---|---|---|
| `name` | `'develop'` | `'improve'` | `'debug'` |
| `defaultMaxConcurrentTasks` | `5` | `5` | `3` |
| `fixerSteps` length | **1** | **2** | **1** |
| `finalReviewers` length | **4** | **4** | **4** |
| `phases` length | **5** (incl. initialization) | **4** (no initialization) | **5** (incl. initialization) |

All three workflows use the **same** `finalReviewers` (efficiency, code-quality, ui-ux, security) and the
same `titleFormatter`.

**fixerSteps detail:**

```ts
// develop & debug — single fix step:
fixerSteps: [
    { name: 'fix', profileId: 'fixer', isReadOnly: false },
]

// improve — fix step + a read-only verification step using ReviewResultSchema:
fixerSteps: [
    { name: 'fix',    profileId: 'fixer',             isReadOnly: false },
    { name: 'verify', profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
]
```

**sidebarPhases detail:** *(field renamed to `phases` — see above)*

```ts
// develop & debug — 5 entries (initialization is present):
phases: [
    { id: 'initialization', label: 'Initialization', icon: '⚙' },
    { id: 'scouting',       label: 'Scouting',       icon: '🔍' },
    { id: 'planning',       label: 'Planning',        icon: '📋' },
    { id: 'implementing',   label: 'Implementing',    icon: '🔨' },
    { id: 'review',         label: 'Review',          icon: '🔎' },
]

// improve — 4 entries (initialization omitted):
phases: [
    { id: 'scouting',     label: 'Scouting',    icon: '🔍' },
    { id: 'planning',     label: 'Planning',     icon: '📋' },
    { id: 'implementing', label: 'Implementing', icon: '🔨' },
    { id: 'review',       label: 'Review',       icon: '🔎' },
]
```

All three workflows use the same `finalReviewers` and `titleFormatter`:

```ts
titleFormatter: (d: string) => d.slice(0, 100),
```

---

## The `run` / `runSpir` Contract

### Thin-wrapper entry point

Each workflow exports an engine-loaded `run` function. Its signature is identical across
all three workflows:

```ts
export async function run(taskPrompt: string, options: RunOptions): Promise<void> {
    return runSpir(workflowConfig, taskPrompt, normalizeOptions(options));
}
```

`RunOptions` extends `SpirRunOptions` with a required `workDir: string`.

### The orchestrator

```ts
export async function runSpir(
    config: WorkflowConfig,
    taskPrompt: string,
    options: SpirRunOptions,
): Promise<void>
```

`runSpir` does the following in order:

1. Resolves `maxConcurrentTasks` (`options.maxConcurrentTasks ?? config.defaultMaxConcurrentTasks`).
2. Resolves `profilesDirs` (`options.profilesDirs ?? resolveProfilesDirs(options.cwd, config.name)`).
3. Loads or creates the `WorkflowStatusTracker` (see [Resumption](#resumption)).
4. Emits `onWorkflowStart`.
5. Builds a mutable `RunState` (seeded from the tracker on resume).
6. Resolves the starting phase index from `tracker.currentPhase`.
7. Generates the sidebar title (AI for fresh runs, truncated prompt for resumed runs).
8. Builds a single immutable `PhaseContext` and passes it to every `executePhase` call.
9. Loops through phases until `done` or cancellation.
10. Emits `onWorkflowComplete` with total duration and agent count.

### PhaseContext

Built **once** in `runSpir` and reused for every phase. Bundling these values into a single
object eliminates the swap-risk of many positional string/optional parameters (e.g. `cwd`
vs `workDir`, both strings):

```ts
export interface PhaseContext {
    tracker: WorkflowStatusTracker;
    profilesDirs: string[];
    taskPrompt: string;
    cwd: string;
    workDir: string;
    maxConcurrentTasks: number | undefined;
    config: WorkflowConfig;
    apiKeys?: Record<string, string>;
    onStatus?: StatusCallbacks;
    signal?: AbortSignal;
}
```

### RunState

Mutable state passed by reference through phases within a single `runSpir()` call.
Mutations made inside `executePhase` are visible to the orchestrator:

```ts
export interface RunState {
    research: string;
    plan: Plan | undefined;
    scoutingReports: unknown[];
    scoutingRounds: number;
    scoutingGaps: ScoutingGap[];
    planningRounds: number;
    planReviewFeedback?: string;
    planReviewSuggestions?: string[];
}
```

---

## SpirRunOptions & normalizeOptions

```ts
export interface SpirRunOptions extends WorkflowRunOptions {
    profilesDirs?: string[];   // preferred: list of profile directories
    profilesDir?: string;      // legacy singular form
}
```

Inherited `WorkflowRunOptions` fields (from the engine): `cwd`, `workDir`, `maxConcurrentTasks`,
`apiKeys`, `onStatus`, `signal`, `tracker`.

### normalizeOptions

```ts
export function normalizeOptions(options: SpirRunOptions): SpirRunOptions
```

Returns a **new** `SpirRunOptions` with `profilesDirs` resolved and the legacy singular
`profilesDir` stripped. Resolution priority:

1. If `profilesDirs` is set → use it directly.
2. Else if `profilesDir` is set → wrap it as `[profilesDir]`.
3. Else → leave `profilesDirs` unset.

The input is never mutated and no `any` cast is used:

```ts
const { profilesDir, profilesDirs, ...rest } = options;
const resolved = profilesDirs ?? (profilesDir ? [profilesDir] : undefined);
return resolved ? { ...rest, profilesDirs: resolved } : rest;
```

> **`onStatus`:** The engine composes the store + UI + bridge callbacks into `onStatus`
> *before* calling `runSpir`. The backbone consumes it directly — it does not construct a
> TUI or EventStore of its own. See the engine docs for the `StatusCallbacks` interface.

---

## Profiles as the Behavioral Differentiator

To customize a workflow's behavior, **edit the profile `.md` files** in `{workflow}/profiles/`
— not the code. The backbone is identical across workflows; each phase loads profiles via the
engine's `resolveProfilesDirs` / `loadProfilesFromDirs` at call time.

The backbone references the following profile IDs:

| Profile ID | Referenced by | Phase | Role |
|---|---|---|---|
| `scout-coordinator` | `scouting.ts` | scouting | Analyzes the task, determines scouting topics (round 0 only) |
| `scout` | `scouting.ts`, `initialization.ts` | scouting, initialization | Investigates a topic and reports findings; also used for AI title generation |
| `scouting-reviewer` | `scouting.ts` | scouting | Reviews scouting reports; decides ready-to-plan vs gaps |
| `planner` | `planning.ts` | planning | Produces a structured implementation plan from research |
| `plan-reviewer` | `planning.ts` | planning | Approves or rejects a plan with feedback |
| `implementer` | `steps.ts` | implementing | Executes a code or non-code task (default implementer profile) |
| `implementer-lite` | `implementation.ts` *(example)* | implementing | Any non-default `profile` on a plan task replaces `implementer` in the `execute` step |
| `implement-reviewer` | `steps.ts`, `improve` fixerSteps | implementing, review | Reviews completed task output against `ReviewResultSchema` |
| `test-writer` | `steps.ts` (`CODE_STEPS`) | implementing | Writes tests first for code tasks |
| `test-reviewer` | `steps.ts` (`CODE_STEPS`) | implementing | Reviews the written tests |
| `fixer` | `final-review.ts`, `develop`/`debug`/`improve` fixerSteps | review | Resolves actionable findings (severity ≥ medium) found by the specialized reviewers |
| `final-reviewer` | *(legacy, unused by default)* | review | The original single whole-codebase quality reviewer; superseded by the four specialized reviewers |
| `efficiency-reviewer` | `final-review.ts` | review | Performance / resource-efficiency dimension of the final review |
| `code-quality-reviewer` | `final-review.ts` | review | Correctness / readability / maintainability dimension of the final review |
| `ui-ux-reviewer` | `final-review.ts` | review | UI/UX dimension of the final review (returns `applicable:false` when no UI changes) |
| `security-reviewer` | `final-review.ts` | review | Security dimension of the final review (returns `applicable:false` when no security surface) |

> **Note:** `implementer-lite` is not hardcoded — it appears only as an example in a code
> comment. The substitution mechanism is generic: any `task.profile` value other than
> `'implementer'` replaces `implementer` in the `execute` step while leaving reviewer steps
> unchanged.

---

## Phase Module Reference

### `helpers.ts`

Shared utilities for profile loading, harness creation, agent-spawn tracking, and audit-event
construction.

| Export | Signature |
|---|---|
| `structuredOutputEvent` | `(agentId, output, taskId?) → Omit<structured_output event, "timestamp">` |
| `decisionEvent` | `(agentId, decision, reasoning, taskId?) → Omit<decision event, "timestamp">` |
| `errorEvent` | `(agentId, error, taskId?) → Omit<error event, "timestamp">` |
| `getProfile` | `(profilesDirs, profileId) → Promise<AgentProfile>` |
| `makeHarnessOptions` | `(profilesDirs, profileId, cwd, agentId, apiKeys?, onStatus?) → Promise<HarnessCreationOptions>` |
| `spawnAgent` | `(tracker, onStatus, info: SpawnInfo) → void` |

`makeHarnessOptions` loads a profile via `getProfile`, then returns `HarnessCreationOptions`
with `onAgentStatus: forwardAgentStatus(onStatus)`. `spawnAgent` is the single source of truth
for the three-line spawn-tracking pattern (status projection + tracker record + counter).

### `scouting.ts`

| Export | Signature |
|---|---|
| `scoutingPhase` | `(tracker, profilesDirs, taskPrompt, cwd, maxConcurrentTasks, workDir, apiKeys?, onStatus?, signal?, phaseOptions?) → Promise<unknown[]>` |
| `scoutingReviewPhase` | `(tracker, profilesDirs, reports, cwd, apiKeys?, onStatus?) → Promise<ScoutingReview>` |

`scoutingPhase` runs the `scout-coordinator` (round 0 only) to get topics, then dispatches
parallel `scout` tasks via `LanePool`. When `phaseOptions.topics` is provided, the coordinator
is skipped. New reports are appended to `phaseOptions.existingReports`. Session directory:
`{workDir}/sessions/scouting-round-{round}`.

### `planning.ts`

| Export | Signature |
|---|---|
| `planningPhase` | `(tracker, profilesDirs, research, taskPrompt, cwd, planReviewFeedback?, planReviewSuggestions?, apiKeys?, onStatus?) → Promise<Plan>` |
| `planReviewPhase` | `(tracker, profilesDirs, plan, research, taskPrompt, cwd, apiKeys?, onStatus?) → Promise<PlanReview>` |

`planningPhase` injects prior review feedback into the planner prompt on retries. Both functions
emit structured-output / decision audit events.

### `implementation.ts`

| Export | Signature |
|---|---|
| `implementationPhase` | `(tracker, profilesDirs, plan, cwd, maxConcurrentTasks, workDir, apiKeys?, onStatus?, signal?) → Promise<void>` |

Loads plan tasks into the shared tracker, validates dependencies, runs a `LanePool` with
`getStepsForTask` selecting `CODE_STEPS` or `NON_CODE_STEPS` based on `task.isCode`. Session
directory: `{workDir}/sessions`.

### `final-review.ts`

| Export | Signature |
|---|---|
| `finalReviewPhase` | `(tracker, profilesDirs, cwd, workDir, maxConcurrentTasks, apiKeys?, onStatus?, signal?, finalReviewers?, fixerSteps?, titleFormatter?) → Promise<boolean>` |
| `DEFAULT_FINAL_REVIEWERS` | `readonly FinalReviewerConfig[]` (efficiency / code-quality / ui-ux / security) |
| `isActionableSeverity` | `(severity) → boolean` (true for medium / high / critical) |

Loops up to 3 rounds. Each round: run every reviewer in `finalReviewers` **in parallel** → audit-log each
result and append to that dimension's history → collect findings rated medium/high/critical from
applicable reviews → if none, return `clean=true`; otherwise spawn one `fixer` task per actionable finding
via `LanePool` (using `fixerSteps`) and loop. Reviewers receive their full prior-round history so they do
not re-report fixed findings. Fixer session directory: `{workDir}/sessions/fix-round-{round}`.

### `initialization.ts`

| Export | Signature |
|---|---|
| `initializationPhase` | `(profilesDirs, taskPrompt, cwd, apiKeys, onStatus, tracker) → Promise<string>` |

Generates a concise AI title using the `scout` profile. Falls back to a truncated
`taskPrompt` (max 60 chars) on any error. Called by `runSpir` before the main loop on fresh
runs only.

### `schemas.ts`

Zod schemas that constrain every structured LLM output in the pipeline:

| Schema | Inferred type | Produced by |
|---|---|---|
| `ScoutingTopicSchema` | `ScoutingTopics` | `scout-coordinator` |
| `ScoutingGapSchema` | `ScoutingGap` | (sub-schema of `ScoutingReviewSchema`) |
| `ScoutingReviewSchema` | `ScoutingReview` | `scouting-reviewer` |
| `PlanSchema` | `Plan` | `planner` |
| `PlanReviewSchema` | `PlanReview` | `plan-reviewer` |
| `ReviewResultSchema` | `ReviewResult` | `test-reviewer`, `implement-reviewer` (via `steps.ts`) |
| `FinalReviewTopicsSchema` | `FinalReviewTopics` | *(legacy; the single `final-reviewer` — superseded by the multi-dimensional review below)* |
| `FinalReviewResultSchema` | `FinalReviewResult` | the four specialized final reviewers (efficiency / code-quality / ui-ux / security) |
| `FinalReviewFindingSchema` | `FinalReviewFinding` | (sub-schema of `FinalReviewResultSchema`) |
| `FinalReviewSeveritySchema` | `FinalReviewSeverity` | `low` \| `medium` \| `high` \| `critical` |
| `TitleSchema` | `{ title: string }` | title generation (`initializationPhase`) |

### `steps.ts`

Frozen `readonly StepDefinition[]` arrays used by the implementation `LanePool`:

```ts
export const CODE_STEPS: readonly StepDefinition[] = [
    { name: 'write-tests',   profileId: 'test-writer',        isReadOnly: false },
    { name: 'review-tests',  profileId: 'test-reviewer',      isReadOnly: true, schema: ReviewResultSchema },
    { name: 'execute',       profileId: 'implementer',        isReadOnly: false },
    { name: 'review',        profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
];

export const NON_CODE_STEPS: readonly StepDefinition[] = [
    { name: 'execute',       profileId: 'implementer',        isReadOnly: false },
    { name: 'review',        profileId: 'implement-reviewer', isReadOnly: true, schema: ReviewResultSchema },
];
```

Code tasks (`is_code: true`) run test-first (4 steps). Non-code tasks skip the test
steps (2 steps).

---

## Resumption

`runSpir` supports resuming a previously started workflow. The tracker is resolved in this
order:

1. **Passed-in tracker** — if `options.tracker instanceof WorkflowStatusTracker`, it is reused.
   It counts as "resumed" only if it has completed phases from a prior run.
2. **Saved state file** — `WorkflowStatusTracker.load(workDir)` attempts to load persisted
   state. If it succeeds, `resumed = true`.
3. **Fresh tracker** — if the load fails with a `"Workflow state file not found"` error, a new
   `WorkflowStatusTracker(workDir)` is created and `resumed = false`. Any other error propagates.

On resume, `RunState` is seeded from the tracker:

| `RunState` field | Seeded from |
|---|---|
| `research` | `tracker.research ?? ""` |
| `plan` | `undefined` (loaded lazily from `tracker.plan` inside `executePhase`) |
| `scoutingReports` | `[]` (re-collected only if scouting re-runs) |
| `scoutingRounds` | `0` |
| `planningRounds` | `0` |
| `planReviewFeedback` | `tracker.planReviewFeedback` |
| `planReviewSuggestions` | `tracker.planReviewSuggestions` (copied) |

The starting phase is determined by `tracker.currentPhase`:

```ts
let currentIndex = PHASES.indexOf(tracker.currentPhase as Phase);
if (currentIndex < 0) {
    currentIndex = 0;                    // fresh tracker — start at scouting
    tracker.setCurrentPhase(PHASES[0]);
}
```

On a fresh run, `runSpir` generates an AI title via `initializationPhase` before entering the
loop. On resume, it uses a truncated prompt as the sidebar title and skips AI generation:

```ts
if (resumed) {
    const shortTitle = taskPrompt.length > 60 ? taskPrompt.slice(0, 57) + '...' : taskPrompt;
    onStatus?.onSidebarUpdate?.({ title: shortTitle, ... });
} else {
    onStatus?.onSidebarUpdate?.({ title: 'Initializing...', indicator: '⚙', ... });
    const title = await initializationPhase(profilesDirs, taskPrompt, cwd, apiKeys, onStatus, tracker);
    onStatus?.onSidebarUpdate?.({ title, ... });
}
```

If `signal.aborted` is detected before a phase starts, `runSpir` saves the tracker, emits
`onWorkflowFailed`, and returns without rethrowing. Any other error is emitted via
`onWorkflowFailed` and then rethrown.
