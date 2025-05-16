import { AgentState, Document } from '../types';

/**
 * Creates a compact summary of the agent state for logging purposes
 * Reduces verbose fields like docs and prevents log size issues
 */
export function createStateSummary(state: Partial<AgentState>): Record<string, any> {
  if (!state) return {};

  // Create a shallow copy of state to modify
  const summary: Record<string, any> = { ...state };

  // Ultra-compact summaries ------------------------------------------------
  if (state.docs) summary.docsCount = state.docs.length;

  // Truncate long messages
  if (state.messages && state.messages.length > 0) {
    const last = state.messages[state.messages.length - 1];
    summary.lastMessage = {
      role: last.role,
      content: last.content.length > 40 ? `${last.content.substring(0, 40)}…` : last.content,
    };
    summary.totalMessages = state.messages.length;
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

  // If there are retrievals, summarize them and include body snippets
  if (state.retrievals) {
    summary.retrievals = state.retrievals.map(r => ({
      category: r.category,
      chunks: r.chunks?.length ?? 0,
    }));
  }

  // If there are task docs in the task entities, summarize those with content snippets
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
            docs: task.docs.map((doc: Document, i: number) => ({
              idx: i,
              id: doc.id,
              title: doc.title || doc.metadata?.title || '[No title]',
              source: doc.metadata?.source || '[Unknown source]',
              bodySnippet: doc.content
                ? doc.content.length > 80
                  ? `${doc.content.substring(0, 80)}...`
                  : doc.content
                : '[No content]',
            })),
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
