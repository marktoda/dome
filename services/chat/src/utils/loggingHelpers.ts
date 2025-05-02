import { AgentState, Document } from '../types';

/**
 * Creates a compact summary of the agent state for logging purposes
 * Reduces verbose fields like docs and prevents log size issues
 */
export function createStateSummary(state: Partial<AgentState>): Record<string, any> {
  if (!state) return {};

  // Create a shallow copy of state to modify
  const summary: Record<string, any> = { ...state };

  // Summarize docs (often the largest part)
  if (state.docs && state.docs.length > 0) {
    summary.docs = state.docs.map((d, i) => ({
      idx: i,
      id: d.id,
      title: d.title,
      source: d.metadata.source,
      url: d.metadata.url,
      relevanceScore: d.metadata.relevanceScore,
    }))
  }

  // Truncate long messages
  if (state.messages && state.messages.length > 0) {
    summary.messages = state.messages.map(msg => ({
      role: msg.role,
      content: msg.content.length > 50 ? `${msg.content.substring(0, 50)}...` : msg.content,
      timestamp: msg.timestamp
    }));
  }

  // Summarize reasoning
  if (state.reasoning && state.reasoning.length > 0) {
    summary.reasoning = `[${state.reasoning.length} reasoning items]`;
  }

  // Truncate instructions if they're long
  if (state.instructions && state.instructions.length > 100) {
    summary.instructions = `${state.instructions.substring(0, 100)}...`;
  }

  // Summarize task entities
  if (state.taskEntities && Object.keys(state.taskEntities).length > 0) {
    summary.taskEntities = state.taskEntities;
  }

  // If there are task docs in the task entities, summarize those too
  if (state.retrievals) {
    summary.retrievals = state.retrievals.map(r => ({
      query: r.query,
      category: r.category,
      chunks: (r.chunks ?? []).map(c => ({
        id: c.id,
        source: c.metadata.source,
        title: c.metadata.title,
        url: c.metadata.url,

      }))
    }))
  }

  // If there are task docs in the task entities, summarize those too
  if (state.taskEntities) {
    for (const taskId in state.taskEntities) {
      const task = state.taskEntities[taskId];
      if (task.docs && task.docs.length > 0) {
        if (typeof summary.taskEntities === 'string') {
          // Convert back to object if we already summarized it
          summary.taskEntities = { ...state.taskEntities };
        }

        if (typeof summary.taskEntities === 'object') {
          summary.taskEntities[taskId] = {
            ...task,
            docs: `[${task.docs.length} docs]`
          };
        }
      }
    }
  }

  // Summarize generated text if it's long
  if (state.generatedText && state.generatedText.length > 100) {
    summary.generatedText = `${state.generatedText.substring(0, 100)}...`;
  }

  return summary;
}
