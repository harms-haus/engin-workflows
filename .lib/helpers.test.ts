import { describe, expect, it, mock } from 'bun:test';
import { createEnginMock } from './engin-mock';

// ─── Mock the broken engin module ───────────────────────────────────────────
// The @harms-haus/engin package has a broken source tree (missing
// lane-pool-widget.ts).  Mock the module so helpers.ts' value-imports
// don't cascade into the TUI tree.

mock.module('@harms-haus/engin-engine', () => ({
  ...createEnginMock(),
}));

// Dynamic import to ensure mock is applied first
const helpers = await import('./helpers');

const { structuredOutputEvent, decisionEvent, errorEvent } = helpers;

// ─── Audit Event Helpers ───────────────────────────────────────────────────

describe('structuredOutputEvent', () => {
  it('creates a structured_output event without timestamp', () => {
    const event = structuredOutputEvent('agent-1', { result: 'ok' });
    expect(event.type).toBe('structured_output');
    expect(event.agentId).toBe('agent-1');
    expect(event.output).toEqual({ result: 'ok' });
    expect((event as Record<string, unknown>).timestamp).toBeUndefined();
  });

  it('includes taskId when provided', () => {
    const event = structuredOutputEvent('agent-1', { result: 'ok' }, 'task-99');
    expect(event.taskId).toBe('task-99');
  });

  it('omits taskId when not provided', () => {
    const event = structuredOutputEvent('agent-1', { result: 'ok' });
    expect((event as Record<string, unknown>).taskId).toBeUndefined();
  });

  it('accepts null output', () => {
    const event = structuredOutputEvent('agent-1', null);
    expect(event.output).toBeNull();
  });

  it('accepts string output', () => {
    const event = structuredOutputEvent('agent-1', 'raw text');
    expect(event.output).toBe('raw text');
  });
});

describe('decisionEvent', () => {
  it('creates a decision event without timestamp', () => {
    const event = decisionEvent('agent-1', 'approve', 'Looks good');
    expect(event.type).toBe('decision');
    expect(event.agentId).toBe('agent-1');
    expect(event.decision).toBe('approve');
    expect(event.reasoning).toBe('Looks good');
    expect((event as Record<string, unknown>).timestamp).toBeUndefined();
  });

  it('includes taskId when provided', () => {
    const event = decisionEvent('agent-1', 'reject', 'Bad', 'task-5');
    expect(event.taskId).toBe('task-5');
  });

  it('omits taskId when not provided', () => {
    const event = decisionEvent('agent-1', 'approve', 'OK');
    expect((event as Record<string, unknown>).taskId).toBeUndefined();
  });
});

describe('errorEvent', () => {
  it('creates an error event without timestamp', () => {
    const event = errorEvent('agent-1', 'Something failed');
    expect(event.type).toBe('error');
    expect(event.agentId).toBe('agent-1');
    expect(event.error).toBe('Something failed');
    expect((event as Record<string, unknown>).timestamp).toBeUndefined();
  });

  it('includes taskId when provided', () => {
    const event = errorEvent('agent-1', 'Failed', 'task-5');
    expect(event.taskId).toBe('task-5');
  });

  it('omits taskId when not provided', () => {
    const event = errorEvent('agent-1', 'Failed');
    expect((event as Record<string, unknown>).taskId).toBeUndefined();
  });
});
