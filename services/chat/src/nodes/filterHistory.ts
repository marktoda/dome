import { getLogger } from '@dome/logging';
import { AgentState, MessagePair } from '../types';
import { getUserId } from '../utils/stateUtils';
import { ObservabilityService } from '../services/observabilityService';
import { countMessagesTokens } from '../utils/tokenCounter';

/**
 * Node: filter_history
 * ------------------------------------------------------------------
 * 1. Implement history trimming to stay within token limits
 * 2. Count tokens and trim from oldest messages first
 * 3. Return state with trimmed chatHistory
 * 
 * This node helps manage the token count in the conversation history
 * by removing older messages when needed to stay within limits.
 */
export const filterHistory = async (
  state: AgentState,
  env: Env,
): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'filterHistory' });
  const t0 = performance.now();

  /* --------------------------------------------------------------- */
  /*  1. Initialize observability                                    */
  /* --------------------------------------------------------------- */
  const userId = getUserId(state);
  const traceId = state.metadata?.traceId ?? ObservabilityService.initTrace(env, userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'filterHistory', state);
  const logEvt = (e: string, p: Record<string, unknown>) => ObservabilityService.logEvent(env, traceId, spanId, e, p);

  // Default max tokens if not specified (8k tokens is a reasonable limit)
  const MAX_HISTORY_TOKENS = 8000;
  
  // If chatHistory doesn't exist, there's nothing to filter
  if (!state.chatHistory || state.chatHistory.length === 0) {
    logger.info('No chat history to filter');
    const elapsed = performance.now() - t0;
    
    ObservabilityService.endSpan(env, traceId, spanId, 'filterHistory', state, state, elapsed);
    
    return {
      ...state,
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'filter_history',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          filterHistory: elapsed,
        },
      },
    };
  }

  try {
    /* --------------------------------------------------------------- */
    /*  2. Count tokens in current history                             */
    /* --------------------------------------------------------------- */
    // Convert MessagePair objects to flat messages for token counting
    const messagesForCounting = state.chatHistory.flatMap(pair => [
      pair.user,
      pair.assistant
    ]);
    
    // Count tokens in the entire chat history
    const totalHistoryTokens = countMessagesTokens(messagesForCounting);
    
    logEvt('filter_history_start', { 
      historyPairCount: state.chatHistory.length,
      totalHistoryTokens
    });

    /* --------------------------------------------------------------- */
    /*  3. Determine if trimming is needed                             */
    /* --------------------------------------------------------------- */
    // If we're under the limit, no need to trim
    if (totalHistoryTokens <= MAX_HISTORY_TOKENS) {
      logger.info({ 
        historyPairCount: state.chatHistory.length,
        totalHistoryTokens,
        maxTokens: MAX_HISTORY_TOKENS
      }, 'History is within token limits, no trimming needed');
      
      const elapsed = performance.now() - t0;
      ObservabilityService.endSpan(env, traceId, spanId, 'filterHistory', state, state, elapsed);
      
      return {
        ...state,
        metadata: {
          ...state.metadata,
          traceId,
          spanId,
          currentNode: 'filter_history',
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            filterHistory: elapsed,
          },
          tokenCounts: {
            ...state.metadata?.tokenCounts,
            chatHistory: totalHistoryTokens,
          },
        },
      };
    }

    /* --------------------------------------------------------------- */
    /*  4. Trim history from oldest messages first                     */
    /* --------------------------------------------------------------- */
    // Sort by timestamp to ensure oldest messages are first
    const sortedHistory = [...state.chatHistory].sort((a, b) => a.timestamp - b.timestamp);
    let trimmedHistory: MessagePair[] = [];
    let runningTokenCount = 0;
    
    // Start from newest and work backwards
    for (let i = sortedHistory.length - 1; i >= 0; i--) {
      const pair = sortedHistory[i];
      const pairTokens = countMessagesTokens([pair.user, pair.assistant]);
      
      // If adding this pair would exceed the limit, stop adding
      if (runningTokenCount + pairTokens > MAX_HISTORY_TOKENS) {
        break;
      }
      
      // Add this pair to our trimmed history and update the token count
      trimmedHistory.unshift(pair); // Add to beginning to maintain chronological order
      runningTokenCount += pairTokens;
    }
    
    const removedPairsCount = state.chatHistory.length - trimmedHistory.length;
    
    logEvt('filter_history_complete', {
      originalPairCount: state.chatHistory.length,
      trimmedPairCount: trimmedHistory.length,
      removedPairsCount,
      originalTokens: totalHistoryTokens,
      remainingTokens: runningTokenCount
    });

    /* --------------------------------------------------------------- */
    /*  5. Log completion and metrics                                  */
    /* --------------------------------------------------------------- */
    const elapsed = performance.now() - t0;
    logger.info({
      originalPairCount: state.chatHistory.length,
      trimmedPairCount: trimmedHistory.length,
      removedPairsCount,
      originalTokens: totalHistoryTokens,
      remainingTokens: runningTokenCount,
      elapsedMs: elapsed
    }, 'filterHistory done');
    
    ObservabilityService.endSpan(env, traceId, spanId, 'filterHistory', state, state, elapsed);

    /* --------------------------------------------------------------- */
    /*  6. Return updated state                                        */
    /* --------------------------------------------------------------- */
    return {
      ...state,
      chatHistory: trimmedHistory,
      reasoning: [
        ...(state.reasoning || []),
        removedPairsCount > 0 
          ? `Trimmed ${removedPairsCount} oldest message pairs to stay within token limit.`
          : 'No history trimming was needed.'
      ],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'filter_history',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          filterHistory: elapsed,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          chatHistory: runningTokenCount,
          originalChatHistory: totalHistoryTokens,
        },
      },
    };
  } catch (error) {
    logger.error({ err: error }, 'Error in filterHistory');
    
    // Handle error case
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const elapsed = performance.now() - t0;
    
    // Add error to metadata before ending span
    const stateWithError = {
      ...state,
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'filterHistory',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };
    
    ObservabilityService.endSpan(env, traceId, spanId, 'filterHistory', state, stateWithError, elapsed);
    
    return {
      ...state,
      reasoning: [...(state.reasoning || []), `Error filtering chat history: ${errorMsg}`],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'filter_history',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          filterHistory: elapsed,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'filterHistory',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};