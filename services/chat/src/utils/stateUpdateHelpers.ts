import { AgentState, Document } from '../types';

// Type guard to ensure docs is always an array
function ensureDocsArray(state: AgentState): AgentState & { docs: Document[] } {
  return {
    ...state,
    docs: state.docs || []
  } as AgentState & { docs: Document[] };
}

/**
 * Update state metadata with timing information
 * @param state Current agent state
 * @param nodeName Name of the node
 * @param executionTime Execution time in milliseconds
 * @param spanId Optional span ID for tracing
 * @returns Updated agent state
 */
export function updateStateWithTiming(
  state: AgentState,
  nodeName: string,
  executionTime: number,
  spanId?: string
): AgentState {
  // Ensure state has the correct structure
  const safeState = ensureDocsArray(state);
  
  return {
    ...safeState,
    metadata: {
      ...safeState.metadata,
      ...(spanId ? { spanId } : {}),
      nodeTimings: {
        ...safeState.metadata?.nodeTimings,
        [nodeName]: executionTime,
      },
    },
  };
}

/**
 * Update state with token count information
 * @param state Current agent state
 * @param category Token count category
 * @param count Token count
 * @returns Updated agent state
 */
export function updateStateWithTokenCount(
  state: AgentState,
  category: string,
  count: number
): AgentState {
  // Ensure state has the correct structure
  const safeState = ensureDocsArray(state);
  
  return {
    ...safeState,
    metadata: {
      ...safeState.metadata,
      tokenCounts: {
        ...safeState.metadata?.tokenCounts,
        [category]: count,
      },
    },
  };
}

/**
 * Add an error to the state
 * @param state Current agent state
 * @param nodeName Name of the node where the error occurred
 * @param error Error object or message
 * @returns Updated agent state
 */
export function addErrorToState(
  state: AgentState,
  nodeName: string,
  error: Error | string
): AgentState {
  const errorMessage = error instanceof Error ? error.message : error;
  
  // Ensure state has the correct structure
  const safeState = ensureDocsArray(state);
  
  return {
    ...safeState,
    metadata: {
      ...safeState.metadata,
      errors: [
        ...(safeState.metadata?.errors || []),
        {
          node: nodeName,
          message: errorMessage,
          timestamp: Date.now(),
        },
      ],
    },
  };
}

/**
 * Update state with multiple metadata fields
 * @param state Current agent state
 * @param updates Object containing metadata updates
 * @returns Updated agent state
 */
export function updateStateMetadata(
  state: AgentState,
  updates: Record<string, any>
): AgentState {
  // Ensure state has the correct structure
  const safeState = ensureDocsArray(state);
  
  return {
    ...safeState,
    metadata: {
      ...safeState.metadata,
      ...updates,
    },
  };
}