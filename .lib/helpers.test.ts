import { describe, expect, it, jest, mock } from 'bun:test';
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

const { spawnAgent, structuredOutputEvent, decisionEvent, errorEvent } = helpers;
type SpawnInfo = helpers.SpawnInfo;

import type { StatusCallbacks, WorkflowStatusTracker } from '@harms-haus/engin-engine';

// ─── SpawnInfo interface ───────────────────────────────────────────────────

describe('SpawnInfo', () => {
  it('has required agentId, profile, phaseId strings', () => {
    const info: SpawnInfo = {
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
    } as SpawnInfo;
    expect(info.agentId).toBe('agent-1');
    expect(info.profile).toBe('test-writer');
    expect(info.phaseId).toBe('implementing');
  });

  it('accepts optional taskId', () => {
    const info: SpawnInfo = {
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
      taskId: 'task-42',
    } as SpawnInfo;
    expect(info.taskId).toBe('task-42');
  });

  it('accepts optional stepIndex', () => {
    const info: SpawnInfo = {
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
      stepIndex: 2,
    } as SpawnInfo;
    expect(info.stepIndex).toBe(2);
  });

  it('stepIndex defaults to undefined when not provided', () => {
    const info: SpawnInfo = {
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
    } as SpawnInfo;
    expect(info.stepIndex).toBeUndefined();
  });

  it('uses phaseId not phase (field renamed)', () => {
    const info: SpawnInfo = {
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
    } as SpawnInfo;
    // @ts-expect-error — 'phase' no longer exists on SpawnInfo
    const _check: typeof info.phase = undefined;
    expect(_check).toBeUndefined();
  });

  it('accepts all optional fields together', () => {
    const info: SpawnInfo = {
      agentId: 'agent-full',
      profile: 'implementer',
      phaseId: 'scouting',
      taskId: 'task-1',
      stepIndex: 0,
    } as SpawnInfo;
    expect(info).toEqual({
      agentId: 'agent-full',
      profile: 'implementer',
      phaseId: 'scouting',
      taskId: 'task-1',
      stepIndex: 0,
    });
  });
});

// ─── spawnAgent ─────────────────────────────────────────────────────────────

describe('spawnAgent', () => {
  it('calls onStatus.onAgentSpawn with the info object', () => {
    const onAgentSpawn = jest.fn();
    const onStatus = { onAgentSpawn } as StatusCallbacks;

    const tracker = {
      recordAgentSpawn: jest.fn(),
      incrementAgentCount: jest.fn(),
    } as unknown as WorkflowStatusTracker;

    const info: SpawnInfo = {
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
      taskId: 'task-42',
      stepIndex: 1,
    } as SpawnInfo;

    spawnAgent(tracker, onStatus, info);

    expect(onAgentSpawn).toHaveBeenCalledTimes(1);
    expect(onAgentSpawn).toHaveBeenCalledWith({
      agentId: 'agent-1',
      profile: 'test-writer',
      phaseId: 'implementing',
      taskId: 'task-42',
      stepIndex: 1,
    });
  });

  it('calls tracker.recordAgentSpawn with the info object', () => {
    const recordAgentSpawn = jest.fn();
    const incrementAgentCount = jest.fn();
    const tracker = { recordAgentSpawn, incrementAgentCount } as unknown as WorkflowStatusTracker;

    const info: SpawnInfo = {
      agentId: 'agent-2',
      profile: 'implementer',
      phaseId: 'planning',
    } as SpawnInfo;

    spawnAgent(tracker, {} as StatusCallbacks, info);

    expect(recordAgentSpawn).toHaveBeenCalledTimes(1);
    expect(recordAgentSpawn).toHaveBeenCalledWith(info);
  });

  it('calls tracker.incrementAgentCount', () => {
    const recordAgentSpawn = jest.fn();
    const incrementAgentCount = jest.fn();
    const tracker = { recordAgentSpawn, incrementAgentCount } as unknown as WorkflowStatusTracker;

    spawnAgent(tracker, {} as StatusCallbacks, {
      agentId: 'agent-3',
      profile: 'scout',
      phaseId: 'scouting',
    } as SpawnInfo);

    expect(incrementAgentCount).toHaveBeenCalledTimes(1);
  });

  it('works when onStatus is undefined', () => {
    const recordAgentSpawn = jest.fn();
    const incrementAgentCount = jest.fn();
    const tracker = { recordAgentSpawn, incrementAgentCount } as unknown as WorkflowStatusTracker;

    expect(() => spawnAgent(tracker, undefined, {
      agentId: 'agent-4',
      profile: 'fixer',
      phaseId: 'review',
    } as SpawnInfo)).not.toThrow();

    expect(recordAgentSpawn).toHaveBeenCalled();
    expect(incrementAgentCount).toHaveBeenCalled();
  });

  it('works when onStatus does not have onAgentSpawn', () => {
    const recordAgentSpawn = jest.fn();
    const incrementAgentCount = jest.fn();
    const tracker = { recordAgentSpawn, incrementAgentCount } as unknown as WorkflowStatusTracker;

    expect(() => spawnAgent(tracker, {} as StatusCallbacks, {
      agentId: 'agent-5',
      profile: 'reviewer',
      phaseId: 'review',
    } as SpawnInfo)).not.toThrow();

    expect(recordAgentSpawn).toHaveBeenCalled();
    expect(incrementAgentCount).toHaveBeenCalled();
  });

  it('passes stepIndex to onAgentSpawn when provided', () => {
    const onAgentSpawn = jest.fn();
    const recordAgentSpawn = jest.fn();
    const incrementAgentCount = jest.fn();
    const tracker = { recordAgentSpawn, incrementAgentCount } as unknown as WorkflowStatusTracker;

    spawnAgent(tracker, { onAgentSpawn } as StatusCallbacks, {
      agentId: 'agent-6',
      profile: 'test-writer',
      phaseId: 'implementing',
      stepIndex: 3,
    } as SpawnInfo);

    expect(onAgentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 3 }),
    );
  });

  it('omits stepIndex from onAgentSpawn when not provided', () => {
    const onAgentSpawn = jest.fn();
    const recordAgentSpawn = jest.fn();
    const incrementAgentCount = jest.fn();
    const tracker = { recordAgentSpawn, incrementAgentCount } as unknown as WorkflowStatusTracker;

    spawnAgent(tracker, { onAgentSpawn } as StatusCallbacks, {
      agentId: 'agent-7',
      profile: 'implementer',
      phaseId: 'implementing',
    } as SpawnInfo);

    const callArg = onAgentSpawn.mock.calls[0][0];
    expect(callArg.stepIndex).toBeUndefined();
  });
});

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
