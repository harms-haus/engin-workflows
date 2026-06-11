/**
 * ImproveRenderer — top-level renderer for "improve" workflows.
 *
 * Composes the horizontal ProgressIndicator (phase bar) with an AgentGrid
 * showing per-agent log panels.  Tab state supports auto-follow (tracking
 * the active phase) and manual pinning when the user clicks a non-active tab.
 */

import { useState } from 'react';
import { registerRenderer } from '@app/renderers/registry';
import type { WorkflowRendererProps } from '@app/renderers/types';
import { AgentGrid } from './AgentGrid';
import './ImproveRenderer.css';
import { ProgressIndicator } from './ProgressIndicator';
import { buildDevelopState, getAgentsForPhase } from './types';

export function ImproveRenderer({ runState }: WorkflowRendererProps) {
  const state = buildDevelopState(runState);
  const [manualTab, setManualTab] = useState<string | null>(null);

  const effectiveTab = manualTab ?? state.currentPhase ?? state.phases[0]?.id ?? '';

  const handleTabClick = (phaseId: string) => {
    if (phaseId === state.currentPhase) {
      setManualTab(null);
    } else {
      setManualTab(phaseId);
    }
  };

  const activeAgents = getAgentsForPhase(state, effectiveTab);

  return (
    <div className="improve-renderer">
      <ProgressIndicator phases={state.phases} activePhaseTab={effectiveTab} onTabClick={handleTabClick} />
      <div className="improve-content">
        <AgentGrid agents={activeAgents} emptyMessage="No agents in this phase" />
      </div>
    </div>
  );
}

registerRenderer('improve', ImproveRenderer);
