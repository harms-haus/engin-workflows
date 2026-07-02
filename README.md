# engin workflows

This directory is a TypeScript repository defining the user's **engin workflows**.
It ships three workflows — `develop`, `improve`, and `debug` — that all run on top
of a single shared **SPIR backbone** in [`.lib/`](./.lib) (Scouting → Planning →
Implementation → Review).

The engin engine loads a workflow by importing `<workflow>/main.ts` and invoking
its exported entry point:

```ts
export async function run(taskPrompt: string, options: RunOptions): Promise<void>
```

Each workflow's `main.ts` is a ~40-line **thin wrapper** that supplies a
`WorkflowConfig` describing *how this workflow differs* from its siblings, then
delegates to the shared `runSpir` orchestrator. All real pipeline logic lives in
`.lib/`.

> For the full backbone architecture, phase implementations, and the complete
> `WorkflowConfig` / `SpirRunOptions` surface, see [`.lib/README.md`](./.lib/README.md).

---

## Repository structure

```
workflows/
├── .lib/                     # Shared SPIR backbone (see .lib/README.md)
│   ├── config.ts             # WorkflowConfig, SpirRunOptions, normalizeOptions()
│   ├── spir.ts               # runSpir() orchestrator, PHASES
│   ├── scouting.ts           # scoutingPhase(), scoutingReviewPhase()
│   ├── planning.ts           # planningPhase()
│   ├── implementation.ts     # implementationPhase()
│   ├── final-review.ts       # finalReviewPhase() (static review strategy)
│   ├── retrospective-council-phase.ts # retrospectiveCouncilPhase() (council review strategy)
│   ├── initialization.ts     # initializationPhase() (AI title generation)
│   ├── helpers.ts            # makeHarnessOptions(), structuredOutputEvent(), decisionEvent(), errorEvent()
│   ├── schemas.ts            # Zod schemas (PlanSchema, ReviewResultSchema, …)
│   ├── renderers.ts          # registerRenderers() — markdown output for planner/plan-reviewer
│   ├── session-utils.ts      # runSingleSessionStructured() one-shot structured session helper
│   ├── steps.ts              # legacy CODE_STEPS / NON_CODE_STEPS arrays
│   ├── package.json
│   └── tsconfig.json
├── develop/
│   ├── main.ts               # thin wrapper
│   ├── profiles/             # 18 agent-profile .md files
│   ├── tests/                # structure + behaviour tests
│   ├── package.json
│   ├── tsconfig.json
│   ├── bunfig.toml
│   └── bun.lock
├── improve/
│   ├── main.ts               # thin wrapper
│   ├── jsdom-setup.ts        # DOM test setup (improve only)
│   ├── profiles/             # 18 agent-profile .md files
│   ├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   ├── bunfig.toml
│   └── bun.lock
├── debug/
│   ├── main.ts               # thin wrapper
│   ├── profiles/             # 17 agent-profile .md files (no worker.md)
│   ├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   ├── bunfig.toml
│   └── bun.lock
└── README.md                 # ← this file
```

Every workflow directory is self-contained: it has its own `package.json`,
`node_modules/`, `bun.lock`, and `tsconfig.json`, but imports the shared backbone
from the sibling `../.lib/` directory.

---

## The thin-wrapper pattern

Each `main.ts` does four things and nothing else:

1. **Imports** `runSpir` (and optionally schemas/types) from `../.lib/spir`.
2. **Defines** an exported `workflowConfig` object — the per-workflow data that
   drives the shared backbone.
3. **Re-exports** the entire backbone via `export * from '../.lib/spir'`. This
   facade lets a workflow's tests import everything from the single `../main`
   entry point.
4. **Exposes** `run(taskPrompt, options)` as the engine entry point, which
   normalizes options and calls `runSpir`.

This is the complete `develop/main.ts`:

```ts
import { runSpir, type SpirRunOptions, type FinalReviewerConfig, normalizeOptions, ReviewResultSchema } from '../.lib/spir';
import type { StepDefinition } from "@harms-haus/engin-engine";

export * from '../.lib/spir';

export const workflowConfig = {
    name: 'develop' as const,
    defaultMaxConcurrentSessions: 20,
    modelConcurrency: {
        zai: 7,                              // shared account-level pool across all zai models
        'zai:glm-5.2': 5,
        'zai:glm-5.1': 5,
        'opencode-go:deepseek-v4-flash': 5,
        'opencode-go:mimo-v2.5': 5,
    },
    reviewStrategy: 'council' as const,
    maxCouncilRounds: 4,
    fixerSteps: [
        { name: 'fix', profileId: 'fixer', isReadOnly: false },
        { name: 'verify', profileId: 'fixer-reviewer', isReadOnly: true, schema: ReviewResultSchema },
    ] as StepDefinition[],
    finalReviewers: [
        { profileId: 'efficiency-reviewer',   dimension: 'efficiency',   label: 'Efficiency' },
        { profileId: 'code-quality-reviewer', dimension: 'code-quality', label: 'Code Quality' },
        { profileId: 'ui-ux-reviewer',        dimension: 'ui-ux',        label: 'UI/UX' },
        { profileId: 'security-reviewer',     dimension: 'security',     label: 'Security' },
        { profileId: 'documentation-reviewer', dimension: 'documentation', label: 'Documentation' },
    ] as FinalReviewerConfig[],
    phases: [
        { id: 'scouting',       label: 'Scouting',       icon: '🔍' },
        { id: 'planning',       label: 'Planning',       icon: '📋' },
        { id: 'implementing',   label: 'Implementing',   icon: '🔨' },
        { id: 'review',         label: 'Review',         icon: '🔎' },
    ],
    titleFormatter: (d: string) => d.slice(0, 100),
};

export type DevelopWorkflowOptions = SpirRunOptions;

export interface RunOptions extends DevelopWorkflowOptions {
    workDir: string;
}

export async function run(taskPrompt: string, options: RunOptions): Promise<void> {
    return runSpir(workflowConfig, taskPrompt, normalizeOptions(options));
}
```

### What differs between the three wrappers

| Field | `develop` | `improve` | `debug` |
|---|---|---|---|
| `name` | `'develop'` | `'improve'` | `'debug'` |
| `defaultMaxConcurrentSessions` | `20` | `20` | `20` |
| `modelConcurrency` | `zai:7`, `zai:glm-5.2:5`, `zai:glm-5.1:5`, `opencode-go:deepseek-v4-flash:5`, `opencode-go:mimo-v2.5:5` | same | same |
| `reviewStrategy` | `'council'` | `'council'` | `'council'` |
| `maxCouncilRounds` | `4` | `4` | `4` |
| `fixerSteps` | `fix` + `verify` (read-only review) | `fix` + `verify` (read-only review) | `fix` + `verify` (read-only review) |
| `finalReviewers` | efficiency / code-quality / ui-ux / security / documentation (same 5) | same 5 | same 5 |
| `phases` | 4 (scouting / planning / implementing / review) | 4 (same) | 4 (same) |
| `titleFormatter` | `d.slice(0, 100)` | `d.slice(0, 100)` | `d.slice(0, 100)` |

In practice, the only code-level difference between the three shipped wrappers
is the `name` field (and the `RunOptions` type alias).
Everything else — scouting, planning, implementation, review — is identical code
shared from `.lib/`. See [`WorkflowConfig`](./.lib/config.ts) for the interface
definition.

---

## How to add a new workflow

1. **Create the directory:** `mkdir my-workflow/` next to `develop/`, `improve/`,
   `debug/`.

2. **Copy `main.ts`** from the closest existing workflow (e.g. `develop/main.ts`)
   and adjust it. The structure stays identical; only the config values change.

3. **Set `name`** — a lowercased slug. This value is passed to the engine's
   `resolveProfilesDirs(cwd, name)`, which is how the engine locates this
   workflow's `profiles/` directory at runtime. It must be unique across
   workflows.

4. **Set `defaultMaxConcurrentSessions`** — the fallback lane-pool width when
   the caller does not pass `maxConcurrentSessions`.

5. **Define `fixerSteps`** — the ordered repair steps run on each actionable
   finding in the final `review` phase. Each step is a `StepDefinition`
   (`{ name, profileId, isReadOnly, schema? }`). All three workflows chain a
   writable `fix` step with a read-only `verify` step (against
   `ReviewResultSchema`, run by the `fixer-reviewer` profile) after it.

5b. **Define `finalReviewers`** *(optional)* — the specialized reviewers run in
   the final review phase. Each entry is a `FinalReviewerConfig`
   (`{ profileId, dimension, label }`). All three shipped workflows use the same
   five: `efficiency-reviewer`, `code-quality-reviewer`, `ui-ux-reviewer`,
   `security-reviewer`, `documentation-reviewer`. With the `'static'` strategy
   each runs as an independent "lane" that loops `review → fixer → review-fixes`
   over its own dimension; with `'council'` the same profiles run via
   `retrospectiveCouncilRunner` (see 5c below).
   (see [`finalReviewPhase` in `.lib/README.md`](./.lib/README.md#final-reviewts)). Omit it to fall
   back to `.lib`'s `DEFAULT_FINAL_REVIEWERS` (the same five).

5c. **Choose `reviewStrategy` and `maxCouncilRounds`** *(optional)* — two
   `WorkflowConfig` fields that select how the final review phase runs:
   - `'static'` *(default if omitted)*: the legacy per-lane design
     ([`finalReviewPhase`](./.lib/final-review.ts)), where each dimension gets
     its own `SessionScheduler` with an independent fixer loop.
   - `'council'`: the retrospective-council pattern
     ([`retrospectiveCouncilPhase`](./.lib/retrospective-council-phase.ts)),
     where all five dimensions run as parallel `TaskGraph` tasks driven by a
     `retrospectiveCouncilRunner`, all sharing one `SessionGate` (seeded from
     `modelConcurrency`) and one `SessionScheduler`. Each dimension task loops
     `convener → buildMembers(fixers) → retrospective → interpretRetrospective`
     until no actionable findings remain or the round cap is hit.
   When `'council'`, `maxCouncilRounds` caps the number of fix rounds per
   dimension (default `4`). All three shipped workflows set
   `reviewStrategy: 'council'`, `maxCouncilRounds: 4`.

6. **Customize `phases`** *(optional)* — the phase chips shown in the UI.
   The `id` of each entry is matched against the backbone's `Phase` type
   (`scouting` | `planning` | `implementing` | `review`) plus the purely-UI
   `initialization` label for the title-generation step. Omit `initialization`
   (as `improve` does) to hide that chip.

7. **Create `profiles/`** — the markdown agent-profile files that the backbone
   and your `fixerSteps` reference by `profileId` (see
   [Profiles — the behavioral differentiator](#profiles--the-behavioral-differentiator)).

8. **Add `tsconfig.json`** — copy an existing one. The key line is:
   ```jsonc
   "include": ["**/*.ts", "**/*.tsx", "../.lib/**/*.ts"]
   ```
   so the backbone is type-checked per-workflow (see [tsconfig](#tsconfig)).

9. **Add `package.json`, `bunfig.toml`, `bun.lock`** — copy from an existing
   workflow; `@harms-haus/engin` and `zod` are the only dependencies.

10. **Add a structure test** — mirror `debug/tests/debug.structure.test.ts`
    (see [Testing](#testing)).

> The full `WorkflowConfig` field reference (including `titleFormatter` and how
> `normalizeOptions` handles the legacy `profilesDir` singular form) is
> documented in [`.lib/README.md`](./.lib/README.md).

---

## Profiles — the behavioral differentiator

Because the pipeline code is shared, **what makes `develop`, `improve`, and
`debug` behave differently is configuration, not branching**:

- The `workflowConfig` values (above) — in practice, only `name` differs.
- **Which agent-profile `.md` files exist** in each `profiles/` directory.

> **Note on `reviewStrategy`:** with `'council'` (the current default), the five
> final-reviewer profiles run through `retrospectiveCouncilRunner` instead of the
> legacy per-lane loop — but **no additional profiles are needed**. The same
> `finalReviewers` config and the same `profiles/*.md` files work under either
> strategy; the difference is entirely in scheduling (shared gate + single
> scheduler vs. per-lane schedulers).

Every workflow resolves its profiles from a directory determined by
`resolveProfilesDirs(options.cwd, config.name)` (or an explicit `profilesDirs`
option). The backbone and step definitions reference profiles by `profileId`:

| Referenced by | `profileId`s |
|---|---|
| `fixerSteps` (config) | `fixer`, `fixer-reviewer` |
| Task `mode` runners (`.lib/implementation.ts`) | `test-writer`, `test-reviewer`, `implementer` (or the task's `profile`), `implement-reviewer` |
| Scouting phase | `scout-coordinator`, `scout`, `scouting-reviewer` |
| Planning phase | `planner`, `plan-reviewer` |
| Final review phase | `efficiency-reviewer`, `code-quality-reviewer`, `ui-ux-reviewer`, `security-reviewer`, `documentation-reviewer`. Under `reviewStrategy: 'static'` each runs as an independent review → fixer → review-fixes lane; under `'council'` (the current default) these same profiles run via `retrospectiveCouncilRunner` (shared gate, convener → members → retrospective loop). `final-reviewer` is the legacy single-reviewer. |
| Initialization (title) | `scout` |

Concrete differences across the three shipped workflows:

- **`develop/` and `improve/`** ship 18 profiles each (including `worker.md`
  and the five specialized final-reviewer profiles added with the
  multi-dimensional review). **`debug/`** ships 17 — no `worker.md`.
  (Note: `worker.md` exists in `develop/` and `improve/` profile dirs but is
  not currently consumed by the backbone code.)
- **`fixer.md`** uses `thinkingLevel: medium` in `develop`, but
  `thinkingLevel: low` in both `improve` and `debug`.

**To customize behavior, edit the profile markdown, not the TypeScript.** Each
profile is a standalone markdown file with YAML frontmatter (`name`, `provider`,
`model`, `thinkingLevel`, `excludeTools`) and a system-prompt body. For example:

```markdown
---
name: fixer
provider: opencode-go
model: mimo-v2.5
thinkingLevel: low
excludeTools:
  - ask_user_question
  - delegate_to_subagents
---

You are a fix agent. Make targeted, minimal fixes to reported issues…
```

---

## Testing

Each workflow has a `tests/` directory. The primary signal is the **structure
test** (e.g. [`debug/tests/debug.structure.test.ts`](./debug/tests/debug.structure.test.ts)),
which verifies the thin-wrapper contract:

- `runSpir` and `normalizeOptions` are imported from `'../.lib/spir'`.
- `main.ts` does `export * from '../.lib/spir'` (so test imports resolve).
- `workflowConfig` has the expected `name`, `defaultMaxConcurrentSessions`,
  `fixerSteps` shape, `finalReviewers` shape, `phases` ids, and a working `titleFormatter`.
- All re-exported phase functions, Zod schemas, and step arrays resolve.
- Negative invariants: no `parallelAgents` references (in `main.ts` *or* `.lib/`),
  no stale `errorEvent` / web-renderer imports, correct header comment.

Run a workflow's tests from inside its directory:

```bash
cd debug && bun test
```

> **Note:** some non-structure tests assert against engine internals and have
> pre-existing cross-repo drift failures against the current `@harms-haus/engin`
> source (being reconciled separately). The **structure tests** are the reliable
> signal for the thin-wrapper model — if those pass, the wrapper is wired
> correctly.

---

## tsconfig

Every workflow carries its own `tsconfig.json` that **includes the shared
backbone**, so the whole pipeline is type-checked per-workflow:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "paths": { "@app/*": ["./node_modules/@harms-haus/engin/web/src/*"] },
    "baseUrl": "."
  },
  "include": ["**/*.ts", "**/*.tsx", "../.lib/**/*.ts"]
}
```

Type-check a single workflow:

```bash
cd develop && bunx tsc --noEmit
```
