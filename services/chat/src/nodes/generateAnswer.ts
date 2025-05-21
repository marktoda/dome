import { getLogger, logError, countTokens, chooseModel, allocateContext } from '@dome/common';
import { LlmService } from '../services/llmService';
import { toDomeError } from '@dome/common/errors';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { formatDocsForPrompt } from '../utils/promptHelpers';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import type { SliceUpdate } from '../types/stateSlices';
import { ObservabilityService } from '../services/observabilityService';
import { buildMessages } from '../utils';
import { getGenerateAnswerPrompt } from '../config/promptsConfig';

/**
 * Generate Answer Node
 *
 * Generates a comprehensive answer based strictly on the combined context from the previous node.
 * This node is responsible for generating a high-quality response that answers the user query
 * using the doc context
 *
 * The node:
 * 1. Takes the original query and the synthesized context from previous nodes
 * 2. Uses a state-of-the-art LLM (GPT-4 Turbo or equivalent) to generate a comprehensive answer
 * 3. Ensures answers are strictly based on the provided context
 * 4. Maintains proper source attribution when references are made
 * 5. Updates agent state with the generated answer
 *
 * This node represents the core answer generation phase of the RAG pipeline,
 * producing the response that will be presented to the user (after validation).
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment variables
 * @returns Updated agent state with generated answer
 */
export type GenerateAnswerUpdate = SliceUpdate<'generatedText'>;

export async function generateAnswer(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<GenerateAnswerUpdate> {
  const t0 = performance.now();
  const logger = getLogger().child({ node: 'generateAnswer' });
  logger.info({ messageCount: state.messages.length }, 'Starting answer generation');

  /* ------------------------------------------------------------------ */
  /*  Initialize tracing and observability                              */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'generateAnswer', state);

  try {
    /* ------------------------------------------------------------------ */
    /*  Prepare context and model configuration                           */
    /* ------------------------------------------------------------------ */
    // Get user query from messages
    const userQuery = state.messages[state.messages.length - 1].content;

    // Get the synthesized context from previous node (fallback to empty if missing)
    let docContext;
    if (state.docs) {
      docContext = formatDocsForPrompt(state.docs);
    } else {
      throw new Error('No synthesized context or documents found in state');
    }

    // Configure model parameters
    const modelConfig = chooseModel({ task: 'generation', explicitId: state.options?.modelId });
    const modelId = modelConfig.id;

    // Calculate token usage and limits
    const contextTokens = countTokens(docContext);
    const userQueryTokens = countTokens(userQuery);
    const systemPromptEstimate = 500; // Placeholder until we actually build the prompt

    // Calculate token limits for response using the new context configuration system
    const { maxResponse: maxResponseTokens } = allocateContext(modelConfig);

    logger.info(
      {
        modelId,
        contextTokens,
        userQueryTokens,
        maxResponseTokens,
        maxContextWindow: modelConfig.maxContextTokens,
      },
      'Token usage breakdown for answer generation',
    );

    // Build the system prompt for answer generation using the central configuration
    // Pass user context if available, but we don't have specific user info in this state
    // In a real implementation, you might extract this from request context or session
    const systemPrompt = getGenerateAnswerPrompt(userQuery, docContext);

    // Build the messages for the LLM
    const chatMessages = buildMessages(systemPrompt, state.chatHistory, userQuery);
    logger.debug(
      {
        chatCount: chatMessages.length,
        firstMsgPreview:
          chatMessages.length > 0 && 'content' in chatMessages[0]
            ? (chatMessages[0] as any).content.substring(0, 100)
            : undefined,
      },
      '[DEBUG] [GenerateAnswer] Built chat messages for LLM',
    );

    // Log context statistics for observability
    ObservabilityService.logEvent(env, traceId, spanId, 'context_stats', {
      contextTokens,
      userQueryTokens,
      maxResponseTokens,
      totalPromptTokens: contextTokens + userQueryTokens + 500, // Approximate
    });

    /* ------------------------------------------------------------------ */
    /*  Generate answer with LLM                                          */
    /* ------------------------------------------------------------------ */
    let responseText = '';

    if (cfg.configurable?.stream?.handleChunk) {
      const stream = LlmService.stream(env, chatMessages, {
        modelId,
        temperature: state.options?.temperature ?? 0.3,
        maxTokens: maxResponseTokens,
      });

      let accumulated = '';
      for await (const chunk of stream) {
        accumulated += chunk as string;
        await cfg.configurable.stream.handleChunk({
          event: 'on_chat_model_stream',
          data: { chunk },
          metadata: { langgraph_node: 'generateAnswer', traceId, spanId },
        });
      }
      responseText = accumulated;
    } else {
      responseText = await LlmService.call(env, chatMessages, {
        modelId,
        temperature: state.options?.temperature ?? 0.3,
        maxTokens: maxResponseTokens,
      });
    }

    /* ------------------------------------------------------------------ */
    /*  Finish, log, and return the state update                          */
    /* ------------------------------------------------------------------ */
    const elapsed = performance.now() - t0;

    // Log completion
    logger.info(
      {
        elapsedMs: elapsed,
        responseLength: responseText.length,
        responsePreview: responseText.substring(0, 100),
      },
      'Answer generation complete',
    );

    // End observability
    ObservabilityService.endSpan(env, traceId, spanId, 'generateAnswer', state, state, elapsed);

    // Return state updates
    return {
      generatedText: responseText,
      metadata: {
        currentNode: 'generateAnswer',
        executionTimeMs: elapsed,
        isFinalState: true,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          generateAnswer: elapsed,
        },
      },
    };
  } catch (err) {
    // Handle errors gracefully
    const domeError = toDomeError(err);
    const elapsed = performance.now() - t0;

    // Log the error
    logError(domeError, 'Error in generateAnswer', { traceId, spanId });

    // End span with error
    ObservabilityService.endSpan(env, traceId, spanId, 'generateAnswer', state, state, elapsed);

    // Format error for state
    const formattedError = {
      node: 'generateAnswer',
      message: domeError.message,
      timestamp: Date.now(),
    };

    // Provide a fallback message for the user
    const fallbackResponse =
      'I apologize, but I encountered an issue while generating an answer to your query. ' +
      'The system team has been notified of this error.';

    // Return error state update with fallback response
    return {
      generatedText: fallbackResponse,
      metadata: {
        currentNode: 'generateAnswer',
        executionTimeMs: elapsed,
        isFinalState: true,
        errors: [...(state.metadata?.errors || []), formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          generateAnswer: elapsed,
        },
      },
    };
  }
}
