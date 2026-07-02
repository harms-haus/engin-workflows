import { describe, expect, it } from 'bun:test';
import type { WorkflowRunOptions } from '@harms-haus/engin-engine';
import type { WorkflowConfig, SpirRunOptions, FinalReviewerConfig } from './config';
import { normalizeOptions } from './config';

// ─── WorkflowConfig: phases field (replaces sidebarPhases) ─────────────────

describe('WorkflowConfig', () => {
  it('has a phases field with the correct shape', () => {
    // Type-level check: a concrete object must satisfy the interface
    const config: WorkflowConfig = {
      name: 'test-workflow',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [{ name: 'fix', profileId: 'fixer', isReadOnly: false }],
      phases: [
        { id: 'scouting', label: 'Scouting', icon: '🔍' },
        { id: 'planning', label: 'Planning', icon: '📋' },
        { id: 'implementing', label: 'Implementing', icon: '🔨' },
        { id: 'review', label: 'Review', icon: '🔎' },
      ],
      titleFormatter: (d: string) => d.slice(0, 100),
    };

    expect(config.phases).toBeDefined();
    expect(config.phases).toHaveLength(4);
    expect(config.phases[0]).toEqual({ id: 'scouting', label: 'Scouting', icon: '🔍' });
    expect(config.phases[1]).toEqual({ id: 'planning', label: 'Planning', icon: '📋' });
    expect(config.phases[2]).toEqual({ id: 'implementing', label: 'Implementing', icon: '🔨' });
    expect(config.phases[3]).toEqual({ id: 'review', label: 'Review', icon: '🔎' });
  });

  it('phases accepts a single-element array', () => {
    const config: WorkflowConfig = {
      name: 'minimal',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [{ id: 'only', label: 'Only Phase', icon: '➡' }],
      titleFormatter: (d: string) => d,
    };
    expect(config.phases).toHaveLength(1);
  });

  it('phases accepts an empty array', () => {
    const config: WorkflowConfig = {
      name: 'empty',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    expect(config.phases).toEqual([]);
  });

  it('each phase entry has id, label, and icon as strings', () => {
    const config: WorkflowConfig = {
      name: 'typed',
      defaultMaxConcurrentSessions: 2,
      fixerSteps: [],
      phases: [
        { id: 'a', label: 'Alpha', icon: 'α' },
        { id: 'b', label: 'Beta', icon: 'β' },
      ],
      titleFormatter: (d: string) => d,
    };
    for (const phase of config.phases) {
      expect(typeof phase.id).toBe('string');
      expect(typeof phase.label).toBe('string');
      expect(typeof phase.icon).toBe('string');
    }
  });

  it('does not expose sidebarPhases (renamed to phases)', () => {
    // Verify that the old name is not part of the interface.
    // We construct a WorkflowConfig with phases and confirm no sidebarPhases key.
    const config: WorkflowConfig = {
      name: 'test',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    // @ts-expect-error — sidebarPhases should no longer exist on WorkflowConfig
    const _check: typeof config.sidebarPhases = undefined;

    expect(_check).toBeUndefined();
  });
});

// ─── WorkflowConfig: finalReviewers field ──────────────────────────────────

describe('WorkflowConfig.finalReviewers', () => {
  it('is optional (config without it still satisfies the interface)', () => {
    const config: WorkflowConfig = {
      name: 'no-reviewers',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    expect(config.finalReviewers).toBeUndefined();
  });

  it('accepts a FinalReviewerConfig[] with profileId, dimension, and label', () => {
    const reviewers: FinalReviewerConfig[] = [
      { profileId: 'efficiency-reviewer', dimension: 'efficiency', label: 'Efficiency' },
      { profileId: 'ui-ux-reviewer', dimension: 'ui-ux', label: 'UI/UX' },
    ];
    const config: WorkflowConfig = {
      name: 'with-reviewers',
      defaultMaxConcurrentSessions: 5,
      fixerSteps: [],
      finalReviewers: reviewers,
      phases: [],
      titleFormatter: (d: string) => d,
    };
    expect(config.finalReviewers).toHaveLength(2);
    expect(config.finalReviewers![0].profileId).toBe('efficiency-reviewer');
    expect(config.finalReviewers![1].dimension).toBe('ui-ux');
  });
});

// ─── WorkflowConfig: modelConcurrency field ───────────────────────────────

describe('WorkflowConfig.modelConcurrency', () => {
  it('is optional (config without it still satisfies the interface)', () => {
    const config: WorkflowConfig = {
      name: 'no-model-concurrency',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    // Accessing it on a concrete object yields undefined at runtime
    expect((config as unknown as Record<string, unknown>).modelConcurrency).toBeUndefined();
  });

  it('accepts a Record<string, number>', () => {
    const config: WorkflowConfig = {
      name: 'with-model-concurrency',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      modelConcurrency: { 'claude-sonnet-4-20250514': 2 },
    };
    expect(config.modelConcurrency).toEqual({ 'claude-sonnet-4-20250514': 2 });
  });

  it('accepts an empty record', () => {
    const config: WorkflowConfig = {
      name: 'empty-model-concurrency',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      modelConcurrency: {},
    };
    expect(config.modelConcurrency).toEqual({});
  });

  it('accepts multiple entries', () => {
    const config: WorkflowConfig = {
      name: 'multi-model-concurrency',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      modelConcurrency: { 'model-a': 1, 'model-b': 2, 'model-c': 3 },
    };
    expect(config.modelConcurrency).toHaveProperty('model-a');
    expect(config.modelConcurrency).toHaveProperty('model-c');
    expect(config.modelConcurrency!['model-b']).toBe(2);
  });
});

// ─── WorkflowConfig: reviewStrategy + maxCouncilRounds fields ────────────

describe('WorkflowConfig.reviewStrategy', () => {
  it('is optional (config without it still satisfies the interface)', () => {
    const config: WorkflowConfig = {
      name: 'no-strategy',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    expect((config as unknown as Record<string, unknown>).reviewStrategy).toBeUndefined();
  });

  it('accepts value "static"', () => {
    const config: WorkflowConfig = {
      name: 'static-strategy',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      reviewStrategy: 'static',
    };
    expect(config.reviewStrategy).toBe('static');
  });

  it('accepts value "council"', () => {
    const config: WorkflowConfig = {
      name: 'council-strategy',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      reviewStrategy: 'council',
    };
    expect(config.reviewStrategy).toBe('council');
  });
});

describe('WorkflowConfig.maxCouncilRounds', () => {
  it('is optional (config without it still satisfies the interface)', () => {
    const config: WorkflowConfig = {
      name: 'no-rounds',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    expect((config as unknown as Record<string, unknown>).maxCouncilRounds).toBeUndefined();
  });

  it('accepts a positive integer', () => {
    const config: WorkflowConfig = {
      name: 'with-rounds',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      maxCouncilRounds: 5,
    };
    expect(config.maxCouncilRounds).toBe(5);
  });

  it('accepts 0 as a valid value (disables retries)', () => {
    const config: WorkflowConfig = {
      name: 'zero-rounds',
      defaultMaxConcurrentSessions: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      maxCouncilRounds: 0,
    };
    expect(config.maxCouncilRounds).toBe(0);
  });
});

describe('WorkflowConfig — reviewStrategy + maxCouncilRounds composition', () => {
  it('accepts both fields together', () => {
    const config: WorkflowConfig = {
      name: 'council-with-rounds',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      reviewStrategy: 'council',
      maxCouncilRounds: 5,
    };
    expect(config.reviewStrategy).toBe('council');
    expect(config.maxCouncilRounds).toBe(5);
  });

  it('accepts reviewStrategy=council without maxCouncilRounds (default at consumption)', () => {
    const config: WorkflowConfig = {
      name: 'council-default-rounds',
      defaultMaxConcurrentSessions: 3,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
      reviewStrategy: 'council',
    };
    expect(config.reviewStrategy).toBe('council');
    expect((config as unknown as Record<string, unknown>).maxCouncilRounds).toBeUndefined();
  });
});

// ─── WorkflowRunOptions ────────────────────────────────────────────────────

describe('WorkflowRunOptions', () => {
  it('is still exported from @harms-haus/engin-engine', () => {
    // Type-level: just verify it's a valid type reference
    const opts: WorkflowRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
    };
    expect(opts.cwd).toBe('/tmp');
    expect(opts.workDir).toBe('/tmp/work');
  });

  it('accepts optional fields', () => {
    const opts: WorkflowRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      maxConcurrentTasks: 5,
      apiKeys: { ANTHROPIC: 'sk-xxx' },
      verbose: true,
    };
    expect(opts.maxConcurrentTasks).toBe(5);
    expect(opts.apiKeys).toEqual({ ANTHROPIC: 'sk-xxx' });
    expect(opts.verbose).toBe(true);
  });
});

// ─── SpirRunOptions ────────────────────────────────────────────────────────

describe('SpirRunOptions', () => {
  it('extends WorkflowRunOptions with profilesDirs', () => {
    const opts: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDirs: ['/profiles/a', '/profiles/b'],
    };
    expect(opts.profilesDirs).toEqual(['/profiles/a', '/profiles/b']);
  });

  it('accepts legacy profilesDir field', () => {
    const opts: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDir: '/profiles/legacy',
    };
    expect(opts.profilesDir).toBe('/profiles/legacy');
  });

  it('allows both profilesDirs and profilesDir (normalize resolves)', () => {
    const opts: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDirs: ['/primary'],
      profilesDir: '/fallback',
    };
    expect(opts.profilesDirs).toEqual(['/primary']);
    expect(opts.profilesDir).toBe('/fallback');
  });

  it('allows neither profilesDirs nor profilesDir', () => {
    const opts: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
    };
    expect(opts.profilesDirs).toBeUndefined();
    expect(opts.profilesDir).toBeUndefined();
  });
});

// ─── normalizeOptions ──────────────────────────────────────────────────────

describe('normalizeOptions', () => {
  it('returns a new object (does not mutate input)', () => {
    const input: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDirs: ['/a'],
    };
    const result = normalizeOptions(input);
    expect(result).not.toBe(input);
  });

  it('uses profilesDirs when present', () => {
    const input: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDirs: ['/a', '/b'],
    };
    const result = normalizeOptions(input);
    expect(result.profilesDirs).toEqual(['/a', '/b']);
  });

  it('falls back to profilesDir wrapped in an array', () => {
    const input: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDir: '/legacy',
    };
    const result = normalizeOptions(input);
    expect(result.profilesDirs).toEqual(['/legacy']);
    expect((result as unknown as Record<string, unknown>).profilesDir).toBeUndefined();
  });

  it('strips the legacy profilesDir field from output', () => {
    const input: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDirs: ['/a'],
      profilesDir: '/legacy',
    };
    const result = normalizeOptions(input);
    expect(result.profilesDirs).toEqual(['/a']);
    expect((result as unknown as Record<string, unknown>).profilesDir).toBeUndefined();
  });

  it('leaves profilesDirs undefined when neither is provided', () => {
    const input: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
    };
    const result = normalizeOptions(input);
    expect(result.profilesDirs).toBeUndefined();
  });

  it('preserves other fields like cwd, workDir, apiKeys, onStatus', () => {
    const onStub = { onWorkflowStart: () => {} };
    const input: SpirRunOptions = {
      cwd: '/project',
      workDir: '/project/work',
      apiKeys: { KEY: 'val' },
      onStatus: onStub as never,
      profilesDirs: ['/p'],
    };
    const result = normalizeOptions(input);
    expect(result.cwd).toBe('/project');
    expect(result.workDir).toBe('/project/work');
    expect(result.apiKeys).toEqual({ KEY: 'val' });
    expect(result.onStatus).toBe(onStub);
  });

  it('handles empty profilesDirs array', () => {
    const input: SpirRunOptions = {
      cwd: '/tmp',
      workDir: '/tmp/work',
      profilesDirs: [],
    };
    const result = normalizeOptions(input);
    expect(result.profilesDirs).toEqual([]);
  });
});
