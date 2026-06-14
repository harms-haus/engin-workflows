import { describe, expect, it } from 'bun:test';
import type { WorkflowRunOptions } from '@harms-haus/engin';
import type { WorkflowConfig, SpirRunOptions, FinalReviewerConfig } from './config';
import { normalizeOptions } from './config';

// ─── WorkflowConfig: phases field (replaces sidebarPhases) ─────────────────

describe('WorkflowConfig', () => {
  it('has a phases field with the correct shape', () => {
    // Type-level check: a concrete object must satisfy the interface
    const config: WorkflowConfig = {
      name: 'test-workflow',
      defaultMaxConcurrentTasks: 3,
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
      defaultMaxConcurrentTasks: 1,
      fixerSteps: [],
      phases: [{ id: 'only', label: 'Only Phase', icon: '➡' }],
      titleFormatter: (d: string) => d,
    };
    expect(config.phases).toHaveLength(1);
  });

  it('phases accepts an empty array', () => {
    const config: WorkflowConfig = {
      name: 'empty',
      defaultMaxConcurrentTasks: 1,
      fixerSteps: [],
      phases: [],
      titleFormatter: (d: string) => d,
    };
    expect(config.phases).toEqual([]);
  });

  it('each phase entry has id, label, and icon as strings', () => {
    const config: WorkflowConfig = {
      name: 'typed',
      defaultMaxConcurrentTasks: 2,
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
      defaultMaxConcurrentTasks: 1,
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
      defaultMaxConcurrentTasks: 1,
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
      defaultMaxConcurrentTasks: 5,
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

// ─── WorkflowRunOptions ────────────────────────────────────────────────────

describe('WorkflowRunOptions', () => {
  it('is still exported from @harms-haus/engin', () => {
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
    expect((result as Record<string, unknown>).profilesDir).toBeUndefined();
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
    expect((result as Record<string, unknown>).profilesDir).toBeUndefined();
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
