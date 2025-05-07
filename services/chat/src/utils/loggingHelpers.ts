import { AgentState, Document } from '../types';

/**
 * Creates a compact summary of the agent state for logging purposes
 * Reduces verbose fields like docs and prevents log size issues
 */
export function createStateSummary(state: Partial<AgentState>): Record<string, any> {
  if (!state) return {};

  // Create a shallow copy of state to modify
  const summary: Record<string, any> = { ...state };

  // Summarize docs (often the largest part) and include content snippets
  if (state.docs && state.docs.length > 0) {
    summary.docs = state.docs.map((d, i) => ({
      idx: i,
      id: d.id,
      title: d.title,
      source: d.metadata.source,
      url: d.metadata.url,
      relevanceScore: d.metadata.relevanceScore,
      // Include a snippet of the document content
      bodySnippet: d.content
        ? d.content.length > 100
          ? `${d.content.substring(0, 100)}...`
          : d.content
        : '[No content]',
    }));
  }

  // Truncate long messages
  if (state.messages && state.messages.length > 0) {
    summary.messages = state.messages.map(msg => ({
      role: msg.role,
      content: msg.content.length > 50 ? `${msg.content.substring(0, 50)}...` : msg.content,
      timestamp: msg.timestamp,
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

  // If there are retrievals, summarize them and include body snippets
  if (state.retrievals) {
    summary.retrievals = state.retrievals.map(r => ({
      query: r.query,
      category: r.category,
      chunks: (r.chunks ?? []).map(c => ({
        id: c.id,
        source: c.metadata.source,
        title: c.metadata.title,
        url: c.metadata.url,
        score: c.metadata.relevanceScore,
        rerankerScore: c.metadata.rerankerScore,
        // Include a snippet of the document content for better debugging
        bodySnippet: c.content
          ? c.content.length > 100
            ? `${c.content.substring(0, 100)}...`
            : c.content
          : '[No content]',
      })),
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
