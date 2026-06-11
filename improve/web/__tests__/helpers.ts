import type { AgentWindowState, PhaseDescriptor, WorkflowRunState, WorkflowSummary } from '@app/types';

export function createPhase(id: string, label?: string, icon?: string): PhaseDescriptor {
  return { id, label: label ?? id, icon: icon ?? '🔵' };
}

export function createAgentWindow(agentId: string, overrides: Partial<AgentWindowState> = {}): AgentWindowState {
  return {
    agentId,
    profile: 'default',
    active: false,
    log: [],
    ...overrides,
  };
}

export function createSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  const sidebar = overrides.sidebar ?? {
    title: 'Test',
    indicator: '…',
    phases: [],
  };
  return {
    id: 'test-run',
    workflowName: 'Test Workflow',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
    sidebar,
  };
}

export function createRunState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    summary: createSummary(),
    agents: new Map(),
    currentPhase: '',
    completedPhases: [],
    ...overrides,
  };
}
