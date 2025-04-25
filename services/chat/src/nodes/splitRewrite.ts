import { getLogger } from '@dome/logging';
import { AgentState, QueryAnalysis } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Split and rewrite the user query to improve retrieval
 */
export const splitRewrite = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'splitRewrite' });
  const startTime = performance.now();

  // Get the last user message
  const lastUserMessage = [...state.messages].reverse().find(msg => msg.role === 'user');

  if (!lastUserMessage) {
    logger.warn('No user message found in history');
    return {
      ...state,
      tasks: {
        ...state.tasks,
        originalQuery: '',
        rewrittenQuery: '',
      },
    };
  }

  const originalQuery = lastUserMessage.content;
  logger.info({ originalQuery, messageCount: state.messages.length }, 'Processing user query');

  // Count tokens in the query
  const tokenCount = countTokens(originalQuery);
  logger.debug({ tokenCount }, 'Counted tokens in query');

  // Create or get trace and span IDs for observability
  const traceId =
    state.metadata?.traceId || ObservabilityService.initTrace(env, state.userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'splitRewrite', state);

  // Log the start of query processing
  ObservabilityService.logEvent(env, traceId, spanId, 'query_processing_start', {
    originalQuery,
    tokenCount,
  });

  // TODO: why do this pre analysis instead of always rewriting?
  // note that for ex: quivr splits into instructions and tasks
  // where instructions are added to system tx and tasks each separately query vectordb
  try {
    // Analyze query complexity to determine if it should be split
    const queryAnalysis = await LlmService.analyzeQueryComplexity(env, originalQuery, {
      traceId,
      spanId,
    });

    // Log the query analysis
    ObservabilityService.logEvent(env, traceId, spanId, 'query_analysis_complete', {
      originalQuery,
      analysis: queryAnalysis,
    });

    // Determine if query needs rewriting
    let needsRewriting = false;

    // Check for multi-part questions
    if (originalQuery.includes('?') && originalQuery.split('?').length > 2) {
      needsRewriting = true;
      logger.info('Query contains multiple questions, needs rewriting');
    }

    // Check for ambiguous references that might need context
    if (/\b(it|this|that|they|these|those)\b/i.test(originalQuery)) {
      needsRewriting = true;
      logger.info('Query contains ambiguous references, needs rewriting');
    }

    // Check if the query analysis suggests it's complex
    if (queryAnalysis.isComplex) {
      needsRewriting = true;
      logger.info(
        { reason: queryAnalysis.reason },
        'Query is complex according to analysis, needs rewriting',
      );
    }

    // Get conversation context for rewriting (last few messages)
    const conversationContext = state.messages
      .slice(-6) // Take last 6 messages for context
      .filter(msg => msg.role !== 'system'); // Exclude system messages

    // Rewrite the query if needed
    let rewrittenQuery = originalQuery;
    if (needsRewriting) {
      logger.info('Rewriting query using LLM');

      // Call LLM to rewrite the query
      rewrittenQuery = await LlmService.rewriteQuery(env, originalQuery, conversationContext, {
        traceId,
        spanId,
      });

      logger.info({ originalQuery, rewrittenQuery }, 'Query rewritten');

      // Log the rewriting
      ObservabilityService.logEvent(env, traceId, spanId, 'query_rewrite_complete', {
        originalQuery,
        rewrittenQuery,
        needsRewriting,
      });
    } else {
      logger.info('Query does not need rewriting');
    }

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Log completion of the node
    ObservabilityService.logEvent(env, traceId, spanId, 'split_rewrite_complete', {
      originalQuery,
      rewrittenQuery,
      executionTimeMs: executionTime,
    });

    // End the span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'splitRewrite',
      state,
      {
        ...state,
        tasks: {
          ...state.tasks,
          originalQuery,
          rewrittenQuery,
          queryAnalysis,
        },
        metadata: {
          ...state.metadata,
          traceId,
          spanId,
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            splitRewrite: executionTime,
          },
          tokenCounts: {
            ...state.metadata?.tokenCounts,
            originalQuery: tokenCount,
            rewrittenQuery: countTokens(rewrittenQuery),
          },
        },
      },
      executionTime,
    );

    logger.info(
      {
        executionTimeMs: executionTime,
        originalQuery,
        rewrittenQuery,
      },
      'Split/rewrite complete',
    );

    return {
      ...state,
      tasks: {
        ...state.tasks,
        originalQuery,
        rewrittenQuery,
        queryAnalysis,
      },
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          splitRewrite: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          originalQuery: tokenCount,
          rewrittenQuery: countTokens(rewrittenQuery),
        },
      },
    };
  } catch (error) {
    // Log the error
    logger.error({ err: error, originalQuery }, 'Error in split/rewrite node');

    // Log the error to observability
    ObservabilityService.logEvent(env, traceId, spanId, 'split_rewrite_error', {
      originalQuery,
      error: error instanceof Error ? error.message : String(error),
    });

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Fall back to original query
    return {
      ...state,
      tasks: {
        ...state.tasks,
        originalQuery,
        rewrittenQuery: originalQuery,
      },
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          splitRewrite: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          originalQuery: tokenCount,
          rewrittenQuery: tokenCount,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'splitRewrite',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};
