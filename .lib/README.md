# `.lib/` — SPIR Backbone

The shared, stateless, config-driven backbone for the **develop**, **improve**, and
**debug** workflows. Each workflow is a ~40-line thin wrapper (`{workflow}/main.ts`)
that supplies a [`WorkflowConfig`](#workflowconfig-parameterization) and delegates to
`runSpir`. All phase logic lives in the `.lib` modules documented here.

> **SPIR** = **S**couting → **P**lanning → **I**mplementation → **R**eview, plus a
> terminal `done` phase.

> **Session-first execution model.** Every phase dispatches work through a
> [`SessionScheduler`](https://www.npmjs.com/package/@harms-haus/engin-engine)
> (replacing the former `RunnerPool` / `LanePool`). A `SessionScheduler` drains a
> `TaskGraph` and resolves a **runner tree** — a composition of composable runners
> (`singleSession`, `linearRunner`, `reviewRunner`, …) — for each task via the
> entry's `runnerFactory` and/or the `beforeTask` hook. Each leaf in the tree calls
> the `runSession` session primitive for one prompt turn. Concurrency is governed by
> `SessionGate` (two-level total + per-model FIFO gate). This replaces the old
> step-array model (`getStepsForTask` + `CODE_STEPS`/`NON_CODE_STEPS`).

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

`.lib/` implements the SPIR model as a phase pipeline driven by the engine's
`PhaseRunner`. It owns:

1. **Phase ordering** — the `PHASES` constant and the `Phase` union type.
2. **Phase declarations** — a `PhaseDefinition[]` array (`{ id, label, icon, run }`)
   passed to `PhaseRunner`.
3. **SPIR-specific orchestration hooks** — registered on the `HookRegistry`:
   `beforePhase` (abort guard + `onPhaseStart`), `shouldRetryPhase` (scouting ≤3
   rounds), `onPhaseSettled` (scouting collect-loop), `afterPhase`
   (`onPhaseComplete` + sidebar indicator).
4. **Top-level orchestrator** — `runSpir`, the single entry point thin wrappers call.

Everything else — the actual scouting, planning, implementation, and review logic —
lives in the sibling phase modules (`scouting.ts`, `planning.ts`, `implementation.ts`,
`final-review.ts`, `initialization.ts`).

Each workflow module imports the backbone via a relative path:

```ts
import { runSpir, type SpirRunOptions, normalizeOptions } from "../.lib/spir";
export * from "../.lib/spir";
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
export const PHASES: readonly Phase[] = [
  "scouting",
  "planning",
  "implementing",
  "review",
  "done",
];

export type Phase =
  | "scouting"
  | "planning"
  | "implementing"
  | "review"
  | "done";
```

### Dispatch model — PhaseRunner

`runSpir` declares the phases as a `PhaseDefinition[]` and drives the engine's
`PhaseRunner`. Each `PhaseDefinition` has `{ id, label, icon, run }` where `run` is an
async callback that executes that phase's business logic. The phase bodies close over
`runSpir`-locals (tracker, profiles, workdir, etc.) and a shared mutable state bag
(`ctx.state`).

The `PhaseRunner` owns phase transitions, state persistence, and hook invocation.
SPIR-specific orchestration (retry loops, cross-round accumulation, sidebar updates) is
**not** in an imperative loop — it is declared as phase-level hooks on the
`HookRegistry`:

| Hook               | Rule            | Purpose                                                                              |
| ------------------ | --------------- | ------------------------------------------------------------------------------------ |
| `beforePhase`      | (first-wins)    | Abort guard (`signal?.aborted` → throws `"Workflow cancelled"`) + `onPhaseStart`     |
| `shouldRetryPhase` | (first-wins)    | Scouting ≤3-rounds retry policy (re-runs scouting while `!ready` and `rounds < 3`)   |
| `onPhaseSettled`   | (observe)       | Scouting collect-loop: folds settled scout-task results into `ctx.state` + tracker   |
| `afterPhase`       | (observe)       | `onPhaseComplete` callback + sidebar indicator update                                |

The `runSpir` `try`/`catch` around `runner.run()` cancels active tasks and persists the
tracker on abort or error, then emits `onWorkflowFailed`.

### Phase progression

```
scouting ──────▶ planning ──────▶ implementing ──────▶ review ──────▶ done
   │  ↺ ≤3                         │
   │  (shouldRetryPhase hook)      │  (reviewRunner drives plan↔review internally)
   └───────────────────────────────┘
```

**Scouting** (`scouting.ts`) — up to **3 rounds** (controlled by `shouldRetryPhase`):

1. **Round 0 (first):** The `scout-coordinator` agent (run via `runSingleSessionStructured`)
   analyzes the task and produces a list of topics (each with a rationale and key files).
   These become scout tasks added to the **shared** `TaskGraph`.
2. **Follow-up rounds:** Topics come directly from the previous review's gaps — the
   `scout-coordinator` is skipped (`phaseOptions.topics` is set).
3. All topics run in parallel as read-only `scout` tasks through a **`SessionScheduler`**. Each
   scout task's runner tree is a `linearRunner` of `singleSession` runners built from
   `SCOUTING_STEPS` (mapped via the entry's `runnerFactory` passed to `taskGraph.addTask`). Because scout tasks accumulate on the
   **shared task graph** across the ≤3 rounds, complete reports are naturally cumulative.
4. The `scouting-reviewer` agent (via `runSingleSessionStructured`) evaluates the combined
   reports and returns `{ ready, research, gaps, files }`. Results are stored in
   `ctx.state` (`scoutingReady`, `scoutingRounds`, `research`, `scoutingGaps`,
   `scoutingFiles`).
   - If `ready` → the `shouldRetryPhase` hook abstains; planning advances.
   - If not ready and `scoutingRounds < 3` → `shouldRetryPhase` returns `true`; scouting re-runs using the gaps as new topics.
   - If 3 rounds exhausted → proceed anyway with current research (gaps are cleared).

> **Cross-round collection** is owned by the `onPhaseSettled` hook: after each scouting
> round it folds the tracker's settled scout-task results into `ctx.state.scoutingReports`
> and persists them to `workflowData` (so the planning phase's resume path works). The
> scouting phase body itself does NOT collect or return reports.

**Planning** (`planning.ts`) — single dispatch, internal replan loop:

1. The plan + plan-review run as a **`reviewRunner`** (execute → review loop) dispatched
   through a `SessionScheduler` (`maxConcurrentSessions: 1`). The planner writes its plan as a
   JSON artifact to `{workDir}/artifacts/plan.json` (filesystem output mode, sandboxed to
   the artifacts directory). The plan-reviewer evaluates it (structured output mode with
   `PlanReviewSchema`: `{ approved, feedback }`).
2. The `reviewRunner` drives the replan-on-rejection cycle internally: on rejection it
   appends feedback to the planner prompt and re-runs the planner, up to
   `DEFAULT_MAX_ROUNDS` times.
3. After the pool settles, the plan artifact is read back and validated against
   `PlanSchema`. Even on review exhaustion (reviewer never approved), the latest plan is
   used (mirrors the prior "exhausted rounds → proceed anyway" behaviour).
4. Scouting files are threaded onto the planning task's `files` so the engine's default
   context-collection hook inlines them into both the planner and plan-reviewer prompts.

**Implementation** (`implementation.ts`):

1. Plan tasks are loaded into the shared `TaskGraph` (renumbered
   to sequential `t-0N` IDs via `assignSequentialTaskIds`, skipping IDs already present).
2. Dependencies are validated (`TaskGraph` performs cycle detection at `addTask` time;
   deadlocked tasks with missing deps are detected and failed by `SessionScheduler.run()`
   via `failDeadlockedTasks()`).
3. A **`SessionScheduler`** runs all tasks in parallel (bounded by `maxConcurrentSessions`,
   which is `maxConcurrentTasks` in the function signature). Each task's **runner tree**
   is resolved by the entry's `runnerFactory` via `resolveImplementationRunner`
   (and/or the `beforeTask` first-wins hook, which can override or skip):

   - **Code tasks** (`isCode: true`) → `linearRunner([reviewRunner(write-tests, review-tests), reviewRunner(write-code, review-code)])`
   - **Non-code tasks** → `reviewRunner(execute, review)`

   The `reviewRunner` drives the execute → review loop (`approved` / reject + feedback,
   up to `DEFAULT_MAX_ROUNDS` rounds). If a task specifies a non-default `profile`
   (e.g. `implementer-lite`), that profile substitutes for `implementer` in the execute
   session while the reviewer session stays unchanged.

4. After the scheduler settles, a defense-in-depth check warns if settled task count ≠ total tasks.
5. When a `worktreeManager` is supplied via options, each task runs in its own isolated
   per-task git worktree (created before the task, merged into the main worktree on
   success, culled on failure), so implementation tasks don't contend on files; when
   omitted, tasks share the `cwd` exactly as before. The per-task worktree lifecycle is
   owned by the engine — see the engine docs.

> **No explicit session wipe on resume.** Replay idempotency (`runSession` skips cached
> sessions via the `.complete` sentinel + `result.json` checksum) handles resumed tasks;
> the scheduler's task lifecycle (parked → ready → active → complete) handles retries.
> The workflow no longer touches persisted sessions on resume.

**Review** (`final-review.ts`) — multi-dimensional review with **per-lane fixer loops**:

Each reviewer runs as an **independent lane** in parallel (by default, from
`config.finalReviewers`: `efficiency-reviewer`, `code-quality-reviewer`,
`ui-ux-reviewer`, `security-reviewer`, `documentation-reviewer`). A lane loops
over its own dimension only:

```
review ──▶ (no actionable findings? lane done)
         (actionable findings) ──▶ fixer ──▶ review-fixes ──┐
                                     ▲                       │
                                     └── still actionable? ───┘
                                     (loop, up to MAX_FIX_ROUNDS=3 fixer attempts)
```

1. The initial `review` pass runs via `runSingleSessionStructured` (wraps `singleSession`
   + the `runSession` primitive) and produces a `FinalReviewResult` —
   `{ dimension, applicable, notApplicableReason, summary, findings[] }`. A reviewer whose
   dimension is irrelevant to the changeset returns `applicable: false` with empty findings.
2. Each finding carries a severity (`low | medium | high | critical`) and a self-contained `fixPrompt`.
3. Findings rated **medium / high / critical** ("actionable") in a lane spawn one `fixer` task each
   **within that lane** (via a per-lane **`SessionScheduler`**, using `config.fixerSteps`). `low` findings are
   recorded but do not fix. Each fixer task's runner tree is a `linearRunner` of `singleSession`
   wrappers (one per fixer step), pre-built so the runner infrastructure drives fixer execution
   through the session primitive.
4. If the initial review is clean, the fixer and review-fixes passes are **skipped entirely** for
   that lane — a clean dimension does no extra work and never re-runs.
5. Otherwise the lane runs `fixer → review-fixes`. The **review-fixes** pass uses `runSingleSessionStructured`
   with the **same reviewer profile** and a verify-focused prompt (role `final-review-fixes`) and confirms
   the prior findings were resolved without introducing regressions. If it still reports actionable
   findings, the lane loops back to the fixer (up to 3 attempts); otherwise the lane is clean.
6. Every pass (initial + verify) is appended to that lane's per-dimension history, so the reviewer
   never re-reports already-fixed items.
7. The phase returns `clean = true` only if **every** lane finished clean. A lane that exhausts its
   3 fixer attempts with findings still open makes the whole phase return `clean = false`. A lane that
   throws (e.g. structured-output failure) is counted as not-clean and the other lanes still complete.

Per-lane fixer session dirs are scoped per dimension + fix round
(`{workDir}/sessions/fix-{dimension}-{n}`) so concurrent lanes never collide.

> **Note:** The `initialization` phase (AI title generation) runs _before_ the phase loop
> in `runSpir`, not inside a `PhaseDefinition`. See [initialization.ts](#initializationts).

---

## WorkflowConfig Parameterization

Defined in `config.ts`. This is the **sole code-level differentiator** between workflows.
The behavioral personality of each workflow comes from its [profile files](#profiles-as-the-behavioral-differentiator),
not from code branches.

```ts
export interface WorkflowConfig {
  name: string;
  defaultMaxConcurrentSessions: number;
  modelConcurrency?: Record<string, number>; // per-model concurrency caps (default {} = unbounded)
  fixerSteps: StepDefinition[];
  finalReviewers?: FinalReviewerConfig[]; // specialized reviewers run in the final review
  phases: { id: string; label: string; icon: string }[];
  titleFormatter: (description: string) => string;
}

export interface FinalReviewerConfig {
  profileId: string; // agent profile to load for this reviewer
  dimension: string; // stable key used to bucket review history across rounds
  label: string; // human-readable label shown in task titles / status
}
```

| Field                          | Type                              | Purpose                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                         | `string`                          | Workflow identifier; used by `resolveProfilesDirs` to find the default profile directory                                                                                                                      |
| `defaultMaxConcurrentSessions` | `number`                          | Fallback for `maxConcurrentSessions` when `options.maxConcurrentTasks` is not provided; passed to each phase's `SessionScheduler`                                                                                   |
| `modelConcurrency`             | `Record<string, number>?`         | Per-model concurrency caps applied by the `SessionScheduler` via `SessionGate`; omit (or `{}`) for unbounded per-model                                                                                              |
| `fixerSteps`                   | `StepDefinition[]`                | Step specs mapped to `singleSession` runners in a per-lane `linearRunner`; each finding spawns one fixer task in the lane's `SessionScheduler`                                                                      |
| `finalReviewers`               | `FinalReviewerConfig[]?`          | Specialized reviewers run as independent lanes in the final review; each loops review → fixer → review-fixes over its own dimension; defaults to efficiency / code-quality / ui-ux / security / documentation |
| `phases`                       | `{ id, label, icon }[]`           | Sidebar UI metadata; `getPhaseIndicator` resolves a phase → icon                                                                                                                                              |
| `titleFormatter`               | `(description: string) => string` | Formats fixer task titles from finding titles                                                                                                                                                                 |

### Config differences across workflows

|                                | `develop`                    | `improve`                 | `debug`                      |
| ------------------------------ | ---------------------------- | ------------------------- | ---------------------------- |
| `name`                         | `'develop'`                  | `'improve'`               | `'debug'`                    |
| `defaultMaxConcurrentSessions` | `5`                          | `5`                       | `3`                          |
| `fixerSteps` length            | **2**                        | **2**                     | **2**                        |
| `finalReviewers` length        | **5**                        | **5**                     | **5**                        |
| `phases` length                | **5** (incl. initialization) | **4** (no initialization) | **5** (incl. initialization) |

All three workflows use the **same** `finalReviewers` (efficiency, code-quality, ui-ux, security, documentation) and the
same `titleFormatter`.

**fixerSteps detail:**

```ts
// All three workflows — a writable fix step followed by a read-only
// verification step (using ReviewResultSchema, run by the fixer-reviewer):
fixerSteps: [
  { name: "fix", profileId: "fixer", isReadOnly: false },
  {
    name: "verify",
    profileId: "fixer-reviewer",
    isReadOnly: true,
    schema: ReviewResultSchema,
  },
];
```

In the session-first model, each `StepDefinition` in `fixerSteps` is mapped to a
`singleSession` runner (the `StepDefinition` fields — `name`, `profileId`, `isReadOnly`,
`schema`, `outputMode` — become the `SessionSpec` minus the deterministic `id`). The
fixer task's runner tree is a `linearRunner` of those `singleSession` runners.

**phases detail:**

```ts
// develop & debug — 5 entries (initialization is present):
phases: [
  { id: "initialization", label: "Initialization", icon: "⚙" },
  { id: "scouting", label: "Scouting", icon: "🔍" },
  { id: "planning", label: "Planning", icon: "📋" },
  { id: "implementing", label: "Implementing", icon: "🔨" },
  { id: "review", label: "Review", icon: "🔎" },
];

// improve — 4 entries (initialization omitted):
phases: [
  { id: "scouting", label: "Scouting", icon: "🔍" },
  { id: "planning", label: "Planning", icon: "📋" },
  { id: "implementing", label: "Implementing", icon: "🔨" },
  { id: "review", label: "Review", icon: "🔎" },
];
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
export async function run(
  taskPrompt: string,
  options: RunOptions,
): Promise<void> {
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
): Promise<void>;
```

`runSpir` does the following in order:

1. Resolves `maxConcurrentTasks` (`options.maxConcurrentTasks ?? config.defaultMaxConcurrentSessions`).
2. Resolves `profilesDirs` (`options.profilesDirs ?? resolveProfilesDirs(options.cwd, config.name)`).
3. Loads or creates the `WorkflowStatusTracker` (see [Resumption](#resumption)).
4. Emits `onWorkflowStart`.
5. Registers all phases via `onPhaseRegister`.
6. Resolves the starting phase from `tracker.currentPhaseId` for the initial sidebar indicator.
7. Generates the sidebar title (AI for fresh runs, truncated prompt for resumed runs).
8. Resolves or creates the `HookRegistry` and registers the default auditor
   (`onStructuredOutput` / `onDecision` observe hooks against `tracker.auditLog`).
9. Declares `PhaseDefinition[]` — each phase body is an async closure that calls the
   corresponding sibling phase function (`scoutingPhase`, `planningPhase`,
   `implementationPhase`, `finalReviewPhase`). The closures share a mutable `ctx.state`
   bag.
10. Registers the SPIR phase hooks (`beforePhase`, `shouldRetryPhase`, `onPhaseSettled`,
    `afterPhase`) on the `HookRegistry`.
11. Constructs a `PhaseRunner` (sliced to the resume start index on resume) and calls
    `runner.run()`.
12. On success, emits `onWorkflowComplete` with total duration and agent count.
13. On error/abort, cancels active tasks, persists the tracker, and emits `onWorkflowFailed`.

### Phase state bag (`ctx.state`)

The `PhaseRunner` passes a shared mutable state bag to every phase body. Fields used by
SPIR (mirror the legacy `RunState` conceptually):

| Field               | Type                     | Purpose                                                                 |
| ------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `research`          | `string`                 | Synthesized scouting research summary                                   |
| `plan`              | `Plan \| undefined`       | Validated implementation plan                                           |
| `scoutingReports`   | `unknown[]`              | Cumulative scout-task results (folded by `onPhaseSettled`)              |
| `scoutingRounds`    | `number`                 | Completed scouting rounds                                               |
| `scoutingGaps`      | `ScoutingGap[]`          | Gaps from the latest review (used as next-round topics)                 |
| `scoutingFiles`     | `string[]`               | Key files for the planner                                               |
| `scoutingReady`     | `boolean`                | Whether scouting review deemed the research sufficient                   |

> `ctx.state` is **not** persisted by the `PhaseRunner` — only phase transitions are.
> Cross-phase data that must survive resume is persisted to `workflowData` via
> `tracker.setWorkflowData(...)` explicitly inside the phase bodies / hooks.

---

## SpirRunOptions & normalizeOptions

```ts
export interface SpirRunOptions extends WorkflowRunOptions {
  profilesDirs?: string[]; // preferred: list of profile directories
  profilesDir?: string; // legacy singular form
}
```

Inherited `WorkflowRunOptions` fields (from the engine): `cwd`, `workDir`, `maxConcurrentTasks`,
`apiKeys`, `onStatus`, `signal`, `tracker`, `rendererRegistry`, `hookRegistry`, `worktreeManager`.

### normalizeOptions

```ts
export function normalizeOptions(options: SpirRunOptions): SpirRunOptions;
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
> _before_ calling `runSpir`. The backbone consumes it directly — it does not construct a
> TUI or EventStore of its own. See the engine docs for the `StatusCallbacks` interface.

---

## Profiles as the Behavioral Differentiator

To customize a workflow's behavior, **edit the profile `.md` files** in `{workflow}/profiles/`
— not the code. The backbone is identical across workflows; each phase loads profiles via the
engine's `resolveProfilesDirs` / `loadProfilesFromDirs` at call time.

The backbone references the following profile IDs:

| Profile ID               | Referenced by                                               | Phase                    | Role                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scout-coordinator`      | `scouting.ts`                                               | scouting                 | Analyzes the task, determines scouting topics (round 0 only)                                                                                                                                                                                                                                                       |
| `scout`                  | `scouting.ts`, `initialization.ts`                          | scouting, initialization | Investigates a topic and reports findings; also used for AI title generation                                                                                                                                                                                                                                       |
| `scouting-reviewer`      | `scouting.ts`                                               | scouting                 | Reviews scouting reports; decides ready-to-plan vs gaps                                                                                                                                                                                                                                                            |
| `planner`                | `planning.ts`                                               | planning                 | Writes the implementation plan JSON artifact from research                                                                                                                                                                                                                                                         |
| `plan-reviewer`          | `planning.ts`                                               | planning                 | Approves or rejects the plan artifact with feedback                                                                                                                                                                                                                                                               |
| `implementer`            | `implementation.ts`                                         | implementing             | Executes a code or non-code task (default implementer profile)                                                                                                                                                                                                                                                     |
| `implementer-lite`       | `implementation.ts` _(example)_                             | implementing             | Any non-default `profile` on a plan task substitutes for `implementer` in the execute session                                                                                                                                                                                                                     |
| `implement-reviewer`     | `implementation.ts`                                         | implementing, review     | Reviews completed task output against `ReviewResultSchema` (via `reviewRunner`)                                                                                                                                                                                                                                    |
| `test-writer`            | `implementation.ts`                                         | implementing             | Writes tests first for code tasks (via `singleSession` in the runner tree)                                                                                                                                                                                                                                         |
| `fixer`                  | `final-review.ts`, `develop`/`debug`/`improve` fixerSteps   | review                   | Resolves actionable findings (severity ≥ medium) found by the specialized reviewers                                                                                                                                                                                                                                |
| `fixer-reviewer`         | `develop`/`debug`/`improve` fixerSteps                      | review                   | The `verify` step — reviews a completed fix (resolution, regressions, scope) against `ReviewResultSchema`                                                                                                                                                                                                          |
| `final-reviewer`         | _(legacy, unused by default)_                               | review                   | The original single whole-codebase quality reviewer; superseded by the specialized reviewers                                                                                                                                                                                                                       |
| `efficiency-reviewer`    | `final-review.ts`                                           | review                   | Performance / resource-efficiency dimension of the final review                                                                                                                                                                                                                                                    |
| `code-quality-reviewer`  | `final-review.ts`                                           | review                   | Correctness / readability / maintainability dimension of the final review                                                                                                                                                                                                                                          |
| `ui-ux-reviewer`         | `final-review.ts`                                           | review                   | UI/UX dimension of the final review (returns `applicable:false` when no UI changes)                                                                                                                                                                                                                                |
| `security-reviewer`      | `final-review.ts`                                           | review                   | Security dimension of the final review (returns `applicable:false` when no security surface)                                                                                                                                                                                                                       |
| `documentation-reviewer` | `final-review.ts`                                           | review                   | Documentation dimension of the final review — locates the docs (README, `docs/`, inline docstrings, API schemas), flags stale / missing / incomplete docs, and proposes structural refactors (e.g. splitting a monolith `README.md` into focused `docs/` pages) via self-contained `fixPrompt`s the fixer executes |

> **Note:** `implementer-lite` is not hardcoded — it appears only as an example in a code
> comment. The substitution mechanism is generic: any `task.profile` value other than
> `'implementer'` substitutes for the implementer in the execute session while leaving
> the reviewer session unchanged.

---

## Phase Module Reference

### `helpers.ts`

Shared utilities for profile loading, harness creation, agent-spawn tracking, and audit-event
construction.

| Export                  | Signature                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `structuredOutputEvent` | `(agentId, output, taskId?) → Omit<structured_output event, "timestamp">`                        |
| `decisionEvent`         | `(agentId, decision, reasoning, taskId?) → Omit<decision event, "timestamp">`                    |
| `errorEvent`            | `(agentId, error, taskId?) → Omit<error event, "timestamp">`                                     |
| `getProfile`            | `(profilesDirs, profileId) → Promise<AgentProfile>`                                              |
| `makeHarnessOptions`    | `(profilesDirs, profileId, cwd, agentId, apiKeys?, onStatus?) → Promise<HarnessCreationOptions>` |
| `spawnAgent`            | `(tracker, onStatus, info: SpawnInfo) → void`                                                    |

`makeHarnessOptions` loads a profile via `getProfile`, then returns `HarnessCreationOptions`
with `onAgentStatus: forwardAgentStatus(onStatus)`. `spawnAgent` is the single source of truth
for the three-line spawn-tracking pattern (status projection + tracker record + counter).

### `session-utils.ts`

| Export                     | Signature                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runSingleSessionStructured` | `(spec, opts) → Promise<T \| undefined>` |

Runs a single structured-output session via `singleSession`, capturing the structured
`SessionResult` through a wrapped `runSession` in the `SessionPlanContext`. Creates a local
`SessionGate({ total: 1, perModel: {} })` so exactly one session executes. Returns the
parsed structured data, or `undefined` when the session did not produce structured output.
Used by scouting, scouting review, initialization, and the final-review lanes.

### `scouting.ts`

| Export                | Signature                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scoutingPhase`       | `(tracker, profilesDirs, taskPrompt, cwd, maxConcurrentTasks = 5, workDir, apiKeys?, onStatus?, signal?, phaseOptions = { round: 0 }, hookRegistry?) → Promise<void>`       |
| `scoutingReviewPhase` | `(tracker, profilesDirs, taskPrompt, reports, cwd, apiKeys?, onStatus?, signal?, hookRegistry?, workDir?) → Promise<ScoutingReview>`                                        |

`scoutingPhase` runs the `scout-coordinator` (round 0 only, via `runSingleSessionStructured`)
to get topics, then adds scout tasks to the **shared `TaskGraph`** and dispatches them through a
**`SessionScheduler`**. Each scout task's runner is a `linearRunner` of `singleSession` runners built
from `SCOUTING_STEPS` (mapped via the entry's `runnerFactory`, a `SessionPlanRunner` factory). When `phaseOptions.topics` is provided,
the coordinator is skipped. Reports accumulate on the shared tracker across rounds (collected by
the `onPhaseSettled` hook in `spir.ts`). Session directory:
`{workDir}/sessions/scouting-round-{round}`.

`scoutingReviewPhase` evaluates the accumulated reports via `runSingleSessionStructured`
(`scouting-reviewer` profile) and returns `{ ready, research, gaps, files }`. The original task
prompt is required so the reviewer can judge sufficiency *for this task*.

### `planning.ts`

| Export          | Signature                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planningPhase` | `(tracker, profilesDirs, research, files, taskPrompt, cwd, workDir, apiKeys?, onStatus?, signal?, rendererRegistry?, hookRegistry?) → Promise<Plan>`                                   |
| `getPlanPath`   | `(workDir) → string` — path to `{workDir}/artifacts/plan.json`                                                                                                                           |
| `getArtifactsDir` | `(workDir) → string` — path to `{workDir}/artifacts`                                                                                                                                   |

`planningPhase` composes a `reviewRunner` (plan → review-plan loop) and dispatches it through a
`SessionScheduler` (`maxConcurrentSessions: 1`). The planner uses **filesystem output mode** — it
writes the plan as a JSON file to `getPlanPath(workDir)` via the `write` tool, sandboxed to the
artifacts directory. The plan-reviewer evaluates the artifact (structured output mode with
`PlanReviewSchema`: `{ approved, feedback }`). The `reviewRunner` appends feedback to the
planner prompt on rejection and re-runs, up to `DEFAULT_MAX_ROUNDS`. After the scheduler settles, the
plan artifact is read back and validated against `PlanSchema`. Scouting files are threaded onto
the task's `files` so the engine's default context-collection hook inlines them.

### `implementation.ts`

| Export                       | Signature                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementationPhase`        | `(tracker, profilesDirs, plan, cwd, maxConcurrentTasks = 5, workDir, apiKeys?, onStatus?, signal?, rendererRegistry?, hookRegistry?, worktreeManager?, modelConcurrency = {}) → Promise<void>`                                                          |
| `resolveImplementationRunner` | `(task: { isCode?, profile?, prompt }) → Runner`                                                                                                                                                                                                       |

Loads plan tasks into the shared `TaskGraph` (renumbered to `t-0N`), validates dependencies, and
runs a **`SessionScheduler`**. Runner resolution is provided via TWO seams sharing
`resolveImplementationRunner`:

1. **`getRunnerForTask`** — the `SessionScheduler` option; returns a `SessionPlanRunner` factory that builds the runner tree for a task.
2. **`beforeTask` hook** — invoked at claim time (first-wins); returns `{ runner }` so a
   workflow's own `beforeTask` subscriber can override the runner, or `{ skip: true }` to skip.

The runner tree mirrors the old step pipeline as composed runners:

- **Code tasks** → `linearRunner([reviewRunner(write-tests, review-tests), reviewRunner(write-code, review-code)])`
- **Non-code tasks** → `reviewRunner(execute, review)`

`reviewRunner` drives the execute → review loop (`approved` / reject + feedback, up to
`DEFAULT_MAX_ROUNDS`). The scheduler enforces retry limits via its task lifecycle. The
optional `worktreeManager` enables per-task worktree isolation. `modelConcurrency` threads
per-model caps into the `SessionGate`. Session directory: `{workDir}/sessions`.

### `final-review.ts`

| Export                    | Signature                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalReviewPhase`        | `(tracker, profilesDirs, cwd, workDir, maxConcurrentTasks, apiKeys?, onStatus?, signal?, finalReviewers?, fixerSteps?, titleFormatter?, hookRegistry?) → Promise<boolean>`                                                        |
| `DEFAULT_FINAL_REVIEWERS` | `readonly FinalReviewerConfig[]` (efficiency / code-quality / ui-ux / security / documentation)                                                                                                                                  |
| `isActionableSeverity`    | `(severity) → boolean` (true for medium / high / critical)                                                                                                                                                                        |

Runs every reviewer in `finalReviewers` as an **independent lane in parallel**. Each lane's
review passes run via `runSingleSessionStructured`. Actionable findings (severity ≥ medium)
spawn fixer tasks in a **per-lane `SessionScheduler`** — each fixer task's runner is a `linearRunner`
of `singleSession` wrappers built from `config.fixerSteps`. The lane loops
`review → fixer → review-fixes` over its own dimension (up to `MAX_FIX_ROUNDS` = 3 fixer attempts);
a lane whose initial review is clean skips the fixer + review-fixes passes. The initial review
(role `final-review`) and the review-fixes pass (role `final-review-fixes`) both use the same
reviewer profile with a verify-focused prompt, and each lane keeps its own per-dimension history
so fixed findings are not re-reported. The phase returns `clean = true` only if every lane
finished clean. Per-lane fixer session directory: `{workDir}/sessions/fix-{dimension}-{fixRound}`.

### `initialization.ts`

| Export                | Signature                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `initializationPhase` | `(profilesDirs, taskPrompt, cwd, apiKeys, onStatus, tracker, workDir?) → Promise<string>`                                |

Generates a concise AI title using the `scout` profile via a dedicated `SessionGate({ total: 1 })`
and `runSession` (out-of-phase: no `SessionScheduler`, no `TaskGraph`, invisible to the task UI).
Falls back to a truncated `taskPrompt` (max 60 chars) on any error. Called by `runSpir` before
the phase loop on fresh runs only. Session directory: `{workDir}/sessions/initialization`.

### `schemas.ts`

Zod schemas that constrain every structured LLM output in the pipeline:

| Schema                      | Inferred type         | Produced by                                                                                    |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `ScoutingTopicSchema`       | `ScoutingTopics`      | `scout-coordinator`                                                                            |
| `ScoutingGapSchema`         | `ScoutingGap`         | (sub-schema of `ScoutingReviewSchema`)                                                         |
| `ScoutingReviewSchema`      | `ScoutingReview`      | `scouting-reviewer`                                                                            |
| `PlanSchema`                | `Plan`                | `planner` (written as `plan.json`, validated on read-back)                                     |
| `PlanReviewSchema`          | `PlanReview`          | `plan-reviewer`                                                                                |
| `ReviewResultSchema`        | `ReviewResult`        | `implement-reviewer` (via `reviewRunner` in `implementation.ts`)                               |
| `FinalReviewTopicsSchema`   | `FinalReviewTopics`   | _(legacy; the single `final-reviewer` — superseded by the multi-dimensional review below)_     |
| `FinalReviewResultSchema`   | `FinalReviewResult`   | the specialized final reviewers (efficiency / code-quality / ui-ux / security / documentation) |
| `FinalReviewFindingSchema`  | `FinalReviewFinding`  | (sub-schema of `FinalReviewResultSchema`)                                                      |
| `FinalReviewSeveritySchema` | `FinalReviewSeverity` | `low` \| `medium` \| `high` \| `critical`                                                      |
| `TitleSchema`               | `{ title: string }`   | title generation (`initializationPhase`)                                                       |

### `steps.ts`

> **Legacy step definitions.** These `readonly StepDefinition[]` arrays are retained for
> reference and backward compatibility, but the implementation phase (`implementation.ts`)
> no longer consumes them directly. The runner tree (`resolveImplementationRunner`) is now
> built from composed runners that reference the same profile IDs.

```ts
export const CODE_STEPS: readonly StepDefinition[] = [
  { name: "write-tests", profileId: "test-writer", isReadOnly: false },
  {
    name: "review-tests",
    profileId: "test-reviewer",
    isReadOnly: true,
    schema: ReviewResultSchema,
  },
  { name: "execute", profileId: "implementer", isReadOnly: false },
  {
    name: "review",
    profileId: "implement-reviewer",
    isReadOnly: true,
    schema: ReviewResultSchema,
  },
];

export const NON_CODE_STEPS: readonly StepDefinition[] = [
  { name: "execute", profileId: "implementer", isReadOnly: false },
  {
    name: "review",
    profileId: "implement-reviewer",
    isReadOnly: true,
    schema: ReviewResultSchema,
  },
];
```

The **runner-spec equivalents** used by `resolveImplementationRunner`:

| Old step array    | New runner tree                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `CODE_STEPS`      | `linearRunner([reviewRunner(write-tests, review-tests), reviewRunner(write-code, review-code)])`          |
| `NON_CODE_STEPS`  | `reviewRunner(execute, review)`                                                                          |

The test loop (test-writer → test-reviewer) and code loop (implementer → implement-reviewer)
run as two independent `reviewRunner`s composed linearly for code tasks.

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

On resume, the starting phase is determined by `tracker.currentPhaseId`:

```ts
const startIndex = currentId
  ? Math.max(0, PHASES.indexOf(currentId as Phase))
  : 0;
const runnerPhases = startIndex > 0 ? phases.slice(startIndex) : phases;
```

Cross-phase data (`research`, `plan`, `scoutingFiles`, `scoutingReports`) is persisted to
`workflowData` via `tracker.setWorkflowData(...)`. On resume, phase bodies lazily re-load
it from the tracker into `ctx.state`:

- `scouting` reads `scoutingRounds` / `scoutingGaps` from `ctx.state` (seeded by the
  `onPhaseSettled` hook in prior rounds).
- `planning` derives `research` from saved `workflowData.research` or
  `workflowData.scoutingReports` (re-reviewing if necessary).
- `implementing` loads the `plan` from `workflowData.plan`.
- Session replay: `runSession` skips cached sessions (`.complete` sentinel + valid
  `result.json`), so partially-completed tasks resume without re-running finished sessions.

On a fresh run, `runSpir` generates an AI title via `initializationPhase` before entering the
loop. On resume, it uses a truncated prompt as the sidebar title and skips AI generation.

If `signal.aborted` is detected (thrown as `"Workflow cancelled"` by the `beforePhase` hook),
`runSpir` saves the tracker, emits `onWorkflowFailed`, and returns without rethrowing. Any other
error is emitted via `onWorkflowFailed` and then rethrown.
