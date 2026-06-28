import { describe, expect, it } from 'bun:test';
import type { StepDefinition } from '@harms-haus/engin-engine';
import { CODE_STEPS, NON_CODE_STEPS } from './steps';

// ─── StepDefinition import resolution ──────────────────────────────────────

describe('StepDefinition', () => {
  it('is importable from @harms-haus/engin-engine', () => {
    // Type-level check: the import must resolve and be usable
    const step: StepDefinition = {
      name: 'test-step',
      profileId: 'test-profile',
      isReadOnly: false,
    };
    expect(step.name).toBe('test-step');
    expect(step.profileId).toBe('test-profile');
    expect(step.isReadOnly).toBe(false);
  });

  it('supports optional schema field', () => {
    const step: StepDefinition = {
      name: 'review-step',
      profileId: 'reviewer',
      isReadOnly: true,
      schema: undefined,
    };
    expect(step.schema).toBeUndefined();
  });

  it('supports optional isApproved function', () => {
    const step: StepDefinition<{ approved: boolean }> = {
      name: 'approval-step',
      profileId: 'approver',
      isReadOnly: true,
      isApproved: (result: { approved: boolean }) => result.approved === true,
    };
    expect(step.isApproved?.({ approved: true })).toBe(true);
    expect(step.isApproved?.({ approved: false })).toBe(false);
  });

  it('supports optional getFeedback function', () => {
    const step: StepDefinition<{ feedback: string }> = {
      name: 'feedback-step',
      profileId: 'feedbacker',
      isReadOnly: true,
      getFeedback: (result: { feedback: string }) => result.feedback ?? 'No feedback',
    };
    expect(step.getFeedback?.({ feedback: 'Good job' })).toBe('Good job');
  });
});

// ─── CODE_STEPS ─────────────────────────────────────────────────────────────

describe('CODE_STEPS', () => {
  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(CODE_STEPS)).toBe(true);
  });

  it('has exactly 4 steps', () => {
    expect(CODE_STEPS).toHaveLength(4);
  });

  it('defines write-tests step', () => {
    const step = CODE_STEPS[0];
    expect(step.name).toBe('write-tests');
    expect(step.profileId).toBe('test-writer');
    expect(step.isReadOnly).toBe(false);
    expect(step.schema).toBeUndefined();
  });

  it('defines review-tests step', () => {
    const step = CODE_STEPS[1];
    expect(step.name).toBe('review-tests');
    expect(step.profileId).toBe('test-reviewer');
    expect(step.isReadOnly).toBe(true);
    expect(step.schema).toBeDefined();
  });

  it('defines execute step', () => {
    const step = CODE_STEPS[2];
    expect(step.name).toBe('execute');
    expect(step.profileId).toBe('implementer');
    expect(step.isReadOnly).toBe(false);
    expect(step.schema).toBeUndefined();
  });

  it('defines review step', () => {
    const step = CODE_STEPS[3];
    expect(step.name).toBe('review');
    expect(step.profileId).toBe('implement-reviewer');
    expect(step.isReadOnly).toBe(true);
    expect(step.schema).toBeDefined();
  });

  it('preserves order: test-first workflow', () => {
    const names = CODE_STEPS.map((s) => s.name);
    expect(names).toEqual(['write-tests', 'review-tests', 'execute', 'review']);
  });

  it('does not mutate across accesses', () => {
    // Verify frozen prevents mutation (will throw in strict mode)
    expect(() => {
      (CODE_STEPS as StepDefinition[]).push({ name: 'extra', profileId: 'x', isReadOnly: false });
    }).toThrow();
  });
});

// ─── NON_CODE_STEPS ─────────────────────────────────────────────────────────

describe('NON_CODE_STEPS', () => {
  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(NON_CODE_STEPS)).toBe(true);
  });

  it('has exactly 2 steps', () => {
    expect(NON_CODE_STEPS).toHaveLength(2);
  });

  it('defines execute step', () => {
    const step = NON_CODE_STEPS[0];
    expect(step.name).toBe('execute');
    expect(step.profileId).toBe('implementer');
    expect(step.isReadOnly).toBe(false);
    expect(step.schema).toBeUndefined();
  });

  it('defines review step', () => {
    const step = NON_CODE_STEPS[1];
    expect(step.name).toBe('review');
    expect(step.profileId).toBe('implement-reviewer');
    expect(step.isReadOnly).toBe(true);
    expect(step.schema).toBeDefined();
  });

  it('does not have test steps', () => {
    const names = NON_CODE_STEPS.map((s) => s.name);
    expect(names).toEqual(['execute', 'review']);
    expect(names).not.toContain('write-tests');
    expect(names).not.toContain('review-tests');
  });

  it('does not mutate across accesses', () => {
    expect(() => {
      (NON_CODE_STEPS as StepDefinition[]).push({ name: 'extra', profileId: 'x', isReadOnly: false });
    }).toThrow();
  });
});
