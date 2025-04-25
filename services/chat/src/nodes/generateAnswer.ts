import { getLogger } from '@dome/logging';
import { AgentState, ToolResult, SourceMetadata } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { formatDocsForPrompt } from '../utils/promptFormatter';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { SearchService } from '../services/searchService';

/**
 * Generate the final answer
 */
export const generateAnswer = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'generateAnswer' });
  const startTime = performance.now();

  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'generateAnswer', state);

  // Prepare context from retrieved documents
  const docs = state.docs || [];
  const formattedDocs = formatDocsForPrompt(docs, state.options.includeSourceInfo);

  // Extract source metadata for attribution
  const sourceMetadata = docs.length > 0 ? SearchService.extractSourceMetadata(docs) : [];

  // Prepare tool results if any
  const toolResults = state.tasks?.toolResults || [];
  const formattedToolResults = formatToolResultsForPrompt(toolResults);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(
    formattedDocs,
    formattedToolResults,
    state.options.includeSourceInfo,
  );

  // Prepare messages for LLM
  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...state.messages,
  ];

  logger.info(
    {
      messageCount: messages.length,
      docsCount: docs.length,
      toolResultsCount: toolResults.length,
      systemPromptLength: systemPrompt.length,
    },
    'Generating answer',
  );

  // Log the generation start event
  ObservabilityService.logEvent(env, traceId, spanId, 'answer_generation_start', {
    messageCount: messages.length,
    docsCount: docs.length,
    toolResultsCount: toolResults.length,
    systemPromptLength: systemPrompt.length,
  });

  try {
    // Call the LLM service to generate a response
    const response = await LlmService.generateResponse(env, state.messages, formattedDocs, {
      traceId,
      spanId,
      temperature: state.options.temperature,
      maxTokens: state.options.maxTokens,
      includeSourceInfo: state.options.includeSourceInfo,
    });

    // Count tokens in the response
    const responseTokenCount = countTokens(response);
    const systemPromptTokenCount = countTokens(systemPrompt);

    logger.info(
      {
        responseLength: response.length,
        responseTokenCount,
        systemPromptTokenCount,
      },
      'Generated answer',
    );

    // Log the LLM call
    ObservabilityService.logLlmCall(
      env,
      traceId,
      spanId,
      LlmService.MODEL,
      messages,
      response,
      performance.now() - startTime,
      {
        prompt: systemPromptTokenCount,
        completion: responseTokenCount,
        total: systemPromptTokenCount + responseTokenCount,
      },
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'generateAnswer',
      state,
      {
        ...state,
        generatedText: response,
        metadata: {
          ...state.metadata,
          spanId,
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            generateAnswer: executionTime,
          },
          tokenCounts: {
            ...state.metadata?.tokenCounts,
            systemPrompt: systemPromptTokenCount,
            response: responseTokenCount,
          },
        },
      },
      executionTime,
    );

    // End the trace if this is the final node
    ObservabilityService.endTrace(
      env,
      traceId,
      {
        ...state,
        generatedText: response,
        metadata: {
          ...state.metadata,
          spanId,
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            generateAnswer: executionTime,
          },
          tokenCounts: {
            ...state.metadata?.tokenCounts,
            systemPrompt: systemPromptTokenCount,
            response: responseTokenCount,
          },
          isFinalState: true,
        },
      },
      getTotalExecutionTime(state) + executionTime,
    );

    return {
      ...state,
      generatedText: response,
      metadata: {
        ...state.metadata,
        spanId,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          generateAnswer: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          systemPrompt: systemPromptTokenCount,
          response: responseTokenCount,
        },
        isFinalState: true,
      },
    };
  } catch (error) {
    logger.error(
      {
        err: error,
      },
      'Error generating answer',
    );

    // Log the error event
    ObservabilityService.logEvent(env, traceId, spanId, 'answer_generation_error', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Provide fallback response
    return {
      ...state,
      generatedText:
        "I'm sorry, but I encountered an issue while generating a response. Please try again.",
      metadata: {
        ...state.metadata,
        spanId,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          generateAnswer: executionTime,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'generateAnswer',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        ],
        isFinalState: true,
      },
    };
  }
};

/**
 * Build system prompt with context and tool results
 */
function buildSystemPrompt(
  formattedDocs: string,
  formattedToolResults: string,
  includeSourceInfo: boolean = true,
): string {
  let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";

  if (formattedDocs) {
    prompt += `Here is relevant information from the user's knowledge base that may help with the response:\n\n${formattedDocs}\n\n`;

    if (includeSourceInfo) {
      prompt +=
        'When referencing information from these documents, include the document number in brackets, e.g., [1], to help the user identify the source.\n\n';
    }
  }

  if (formattedToolResults) {
    prompt += `I've used tools to gather additional information:\n\n${formattedToolResults}\n\n`;
    prompt += 'Incorporate this tool-generated information into your response when relevant.\n\n';
  }

  prompt +=
    "Provide a helpful, accurate, and concise response based on the provided context and your knowledge. If the provided context doesn't contain relevant information, acknowledge this and provide the best answer you can based on general knowledge.";

  return prompt;
}

/**
 * Format tool results for inclusion in prompt
 */
function formatToolResultsForPrompt(toolResults: ToolResult[]): string {
  if (toolResults.length === 0) {
    return '';
  }

  return toolResults
    .map((result, index) => {
      const output = result.error
        ? `Error: ${result.error}`
        : typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output, null, 2);

      return `[Tool ${index + 1}] ${result.toolName}\nInput: ${result.input}\nOutput: ${output}`;
    })
    .join('\n\n');
}

/**
 * Calculate total execution time from node timings
 */
function getTotalExecutionTime(state: AgentState): number {
  const nodeTimings = state.metadata?.nodeTimings || {};
  return Object.values(nodeTimings).reduce((sum, time) => sum + time, 0);
}
