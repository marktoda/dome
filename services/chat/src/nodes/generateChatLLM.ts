import { getLogger, logError, countTokens, getModelConfig, calculateTokenLimits } from '@dome/common';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { AgentState } from '../types';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { ModelFactory } from '../services/modelFactory';
import { getChatLLMPrompt } from '../config/promptsConfig';

/**
 * Simple Chat LLM Node
 *
 * Fallback generation path for use cases without retrieval.
 * Uses a simplified prompt suitable for regular chat interactions.
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment variables
 * @returns Updated agent state with generated answer
 */
export async function generateChatLLM(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'generateChatLLM' });
  logger.info({ messageCount: state.messages.length }, 'Starting simple chat generation');

  /* ------------------------------------------------------------------ */
  /*  Trace / logging helpers                                           */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'generateChatLLM', state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  /* ------------------------------------------------------------------ */
  /*  Prompt setup                                                      */
  /* ------------------------------------------------------------------ */
  const modelId = state.options?.modelId;
  const modelConfig = getModelConfig(modelId);

  // Build simple system prompt for non-RAG chat
  const systemPrompt = buildChatSystemPrompt();
  const sysTokens = countTokens(systemPrompt);
  const userTokens = state.messages.reduce((t, m) => t + countTokens(m.content), 0);

  // Calculate token limits based on model constraints
  const { maxResponseTokens } = calculateTokenLimits(
    modelConfig,
    sysTokens + userTokens,
    state.options?.maxTokens,
  );

  // Prepare chat messages with system prompt
  const chatMessages = [{ role: 'system', content: systemPrompt }, ...state.messages];

  // Log context statistics for observability
  logEvt('context_stats', {
    sysTokens,
    userTokens,
    maxResponseTokens,
  });

  /* ------------------------------------------------------------------ */
  /*  Streaming setup for response generation                           */
  /* ------------------------------------------------------------------ */
  let fullText = '';

  try {
    // Create streaming-enabled model
    const streamingModel = ModelFactory.createChatModel(env, {
      modelId: modelId,
      temperature: state.options?.temperature ?? 0.7,
      maxTokens: maxResponseTokens,
      streaming: true,
    });

    // Set up streaming through LangGraph (with null check)
    if (cfg.configurable?.stream) {
      // Get the stream handler from LangGraph config
      const nodeHandler = cfg.configurable?.stream;

      // Start streaming
      const stream = await streamingModel.stream(
        chatMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      );

      // Setup tracking for the token stream
      let tokenCount = 0;
      const streamStart = performance.now();

      // Process each chunk in the stream
      for await (const chunk of stream) {
        // Accumulate the full text
        if (chunk.content) {
          fullText += chunk.content;
          tokenCount += 1;
        }

        // Send the chunk through LangGraph's stream handler
        await nodeHandler.handleChunk({
          event: 'on_chat_model_stream',
          data: { chunk },
          metadata: {
            langgraph_node: 'generate_chat_llm',
            traceId,
            spanId,
          },
        });
      }

      // Log streaming metrics
      const streamDuration = performance.now() - streamStart;
      logEvt('streaming_complete', {
        tokenCount,
        streamDurationMs: streamDuration,
        tokensPerSecond: tokenCount / (streamDuration / 1000),
      });
    } else {
      // Fallback to non-streaming if LangGraph streaming is not configured
      const response = await streamingModel.invoke(
        chatMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      );

      fullText = response.text;
    }
  } catch (error) {
    // Handle errors gracefully
    logError(error, 'Error in chat generation');
    logger.error({ error }, 'Failed to generate streaming answer');
    fullText =
      'I apologize, but I encountered an error while generating your answer. Please try again.';
  }

  /* ------------------------------------------------------------------ */
  /*  Finish, log, and return the state update                          */
  /* ------------------------------------------------------------------ */
  const elapsed = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, 'generateChatLLM', state, state, elapsed);
  ObservabilityService.endTrace(env, traceId, state, elapsed);

  logger.info(
    {
      elapsedMs: elapsed,
      responseLength: fullText.length,
    },
    'Chat generation complete',
  );

  return {
    generatedText: fullText,
    metadata: {
      currentNode: 'generate_chat_llm',
      isFinalState: true,
      executionTimeMs: elapsed,
    },
  };
}

/* ---------------------------------------------------------------------- */
/*  Helpers                                                               */
/* ---------------------------------------------------------------------- */

/**
 * Build a simple system prompt for non-RAG chat interactions
 */
function buildChatSystemPrompt(): string {
  return getChatLLMPrompt();
}
