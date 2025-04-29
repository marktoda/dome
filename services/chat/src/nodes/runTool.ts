import { getLogger } from '@dome/logging';
import { AgentState, Document, ToolResult } from '../types';
import { SecureToolExecutor } from '../tools/secureToolExecutor';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Execute a selected tool securely and convert its output to document format
 * for further processing in the RAG pipeline
 */
export const runTool = async (
  state: AgentState,
  env: Env,
  toolExecutor: SecureToolExecutor = new SecureToolExecutor(),
): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'runTool' });
  const startTime = performance.now();

  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'runTool', state);

  // Get task information
  const taskIds = state.taskIds || [];
  const taskEntities = state.taskEntities || {};

  // Find the task with a tool to run
  let taskToRunTool: string | null = null;
  for (const taskId of taskIds) {
    const task = taskEntities[taskId];
    if (task?.toolToRun) {
      taskToRunTool = taskId;
      break;
    }
  }

  if (!taskToRunTool) {
    logger.warn({ traceId, spanId }, 'No task with tool specified but reached run_tool node');

    // End the span
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    ObservabilityService.endSpan(env, traceId, spanId, 'runTool', state, state, executionTime);

    return state;
  }

  // Get the task and tool information
  const task = taskEntities[taskToRunTool];
  const toolName = task.toolToRun!;
  const toolParameters = task.toolParameters || {};
  const query = task.originalQuery || task.rewrittenQuery || '';

  logger.info(
    {
      taskId: taskToRunTool,
      toolName,
      toolParameters,
      query: task.originalQuery,
      traceId,
      spanId,
    },
    'Running tool',
  );

  try {
    // Use the secure tool executor if provided
    let toolOutput;
    if (toolExecutor) {
      const originalQuery = task.originalQuery || '';
      toolOutput = await toolExecutor.executeTool(toolName, toolParameters, originalQuery, env);
    } else {
      // Otherwise use the legacy approach
      // Get tool from registry
      const tool = await getToolFromRegistry(toolName);

      if (!tool) {
        throw new Error(`Tool ${toolName} not found in registry`);
      }

      // Validate tool parameters
      const validation = await validateToolInput(toolName, toolParameters);

      if (!validation.valid) {
        throw new Error(`Invalid tool parameters: ${validation.error}`);
      }

      // Execute tool with timeout and retry logic
      toolOutput = await executeToolWithRetry(tool.execute, toolParameters, env, traceId, spanId);
    }

    logger.info(
      {
        taskId: taskToRunTool,
        toolName,
        toolParameters,
        toolOutputPreview:
          typeof toolOutput === 'string' ? toolOutput.substring(0, 100) : 'complex output',
        traceId,
        spanId,
      },
      'Tool execution complete',
    );

    // Convert tool output to properly formatted Document objects
    const toolDocuments = await convertToolOutputToDocuments(toolName, toolOutput, query);

    // Score the tool documents for relevance
    const scoredDocuments = await scoreToolDocuments(toolDocuments, query);

    // Create tool result
    const toolResult: ToolResult = {
      toolName,
      input: toolParameters,
      output: toolOutput,
      executionTimeMs: performance.now() - startTime,
    };

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Create updated state with retrieved documents
    const updatedState = {
      ...state,
      // Add tool output documents to state
      docs: [
        ...(state.docs || []),
        ...scoredDocuments
      ],
    };

    // Add tool results to the task
    updatedState.taskEntities = {
      ...(taskEntities || {}),
      [taskToRunTool]: {
        ...(taskEntities[taskToRunTool] || { id: taskToRunTool }), // Ensure id is always present
        toolResults: [...(task.toolResults || []), toolResult],
      },
    };

    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'runTool',
      state,
      updatedState,
      executionTime,
    );

    // Log the tool execution event
    ObservabilityService.logEvent(env, traceId, spanId, 'tool_execution_complete', {
      taskId: taskToRunTool,
      toolName,
      executionTimeMs: executionTime,
      hasOutput: !!toolOutput,
    });

    return {
      ...updatedState,
      metadata: {
        ...updatedState.metadata,
        nodeTimings: {
          ...updatedState.metadata?.nodeTimings,
          runTool: executionTime,
        },
      },
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        taskId: taskToRunTool,
        toolName,
        toolParameters,
        traceId,
        spanId,
      },
      'Error executing tool',
    );

    // Try to use a fallback mechanism if available
    const fallbackResult = await tryFallbackMechanism(
      toolName,
      toolParameters,
      error,
      env,
      traceId,
      spanId,
    );

    // Create error result
    const toolResult: ToolResult = {
      toolName,
      input: toolParameters,
      output: fallbackResult || null,
      error: error instanceof Error ? error.message : String(error),
      executionTimeMs: performance.now() - startTime,
    };

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Create updated state with error information
    const updatedState = {
      ...state,
    };

    // Add error tool result to the task
    updatedState.taskEntities = {
      ...(taskEntities || {}),
      [taskToRunTool]: {
        ...(taskEntities[taskToRunTool] || { id: taskToRunTool }), // Ensure id is always present
        toolResults: [...(task.toolResults || []), toolResult],
        toolError: error instanceof Error ? error.message : String(error),
      },
    };

    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'runTool',
      state,
      updatedState,
      executionTime,
    );

    // Log the error event
    ObservabilityService.logEvent(env, traceId, spanId, 'tool_execution_error', {
      taskId: taskToRunTool,
      toolName,
      error: error instanceof Error ? error.message : String(error),
      hasFallbackResult: !!fallbackResult,
      executionTimeMs: executionTime,
    });

    return {
      ...updatedState,
      metadata: {
        ...updatedState.metadata,
        nodeTimings: {
          ...updatedState.metadata?.nodeTimings,
          runTool: executionTime,
        },
        errors: [
          ...(updatedState.metadata?.errors || []),
          {
            node: 'runTool',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};

/**
 * Get a tool from the registry
 * @param toolName Tool name
 * @returns Tool object or null if not found
 */
async function getToolFromRegistry(toolName: string): Promise<any> {
  // This is a placeholder for the actual implementation
  // In a real implementation, this would use the ToolRegistry
  return {
    execute: async (input: any, env: Env) => {
      return { result: 'This is a mock tool result' };
    },
  };
}

/**
 * Validate tool input parameters
 * @param toolName Tool name
 * @param parameters Tool parameters
 * @returns Validation result
 */
async function validateToolInput(
  toolName: string,
  parameters: any,
): Promise<{ valid: boolean; error?: string }> {
  // This is a placeholder for the actual implementation
  // In a real implementation, this would use the ToolRegistry
  return { valid: true };
}

/**
 * Execute a tool with timeout and retry logic
 * @param executeFunction Tool execution function
 * @param parameters Tool parameters
 * @param env Environment bindings
 * @param traceId Trace ID for observability
 * @param spanId Span ID for observability
 * @returns Tool execution result
 */
async function executeToolWithRetry(
  executeFunction: (input: any, env: Env) => Promise<any>,
  parameters: any,
  env: Env,
  traceId: string,
  spanId: string,
): Promise<any> {
  const logger = getLogger().child({ function: 'executeToolWithRetry' });
  const maxRetries = 2;
  const timeout = 10000; // 10 seconds

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute with timeout
      const result = await Promise.race([
        executeFunction(parameters, env),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Tool execution timed out')), timeout),
        ),
      ]);

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn(
        {
          err: lastError,
          attempt,
          maxRetries,
          traceId,
          spanId,
        },
        'Tool execution failed, retrying',
      );

      // If this was the last retry, don't wait
      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff
      const backoffMs = Math.min(100 * Math.pow(2, attempt), 1000);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  // If we get here, all retries failed
  throw lastError || new Error('Tool execution failed after retries');
}

/**
 * Try to use a fallback mechanism for a failed tool
 * @param toolName Tool name
 * @param parameters Tool parameters
 * @param error Original error
 * @param env Environment bindings
 * @param traceId Trace ID for observability
 * @param spanId Span ID for observability
 * @returns Fallback result or null if no fallback is available
 */
async function tryFallbackMechanism(
  toolName: string,
  parameters: any,
  error: unknown,
  env: Env,
  traceId: string,
  spanId: string,
): Promise<any> {
  const logger = getLogger().child({ function: 'tryFallbackMechanism' });

  logger.info(
    {
      toolName,
      error: error instanceof Error ? error.message : String(error),
      traceId,
      spanId,
    },
    'Attempting fallback mechanism',
  );

  // Different fallback strategies based on the tool
  switch (toolName) {
    case 'calculator':
      // For calculator, return a simple error message
      return {
        error: 'Could not perform calculation',
        suggestion: 'Please try a simpler expression',
      };

    case 'weather':
      // For weather, return a generic weather response
      return {
        note: 'This is a fallback response due to an error',
        weather: 'Unable to retrieve current weather information',
        suggestion: 'Please try again later or specify a different location',
      };

    case 'web_search':
      // For web search, return a message suggesting alternative search terms
      return {
        note: 'This is a fallback response due to an error',
        message: 'Unable to perform web search',
        suggestion: 'Please try different search terms or try again later',
      };

    case 'calendar':
      // For calendar, return a message about unavailability
      return {
        note: 'This is a fallback response due to an error',
        message: 'Unable to access calendar information',
        suggestion: 'Please try again later or check your calendar access permissions',
      };

    default:
      // Generic fallback for other tools
      return {
        note: 'This is a fallback response due to an error',
        message: `The ${toolName} tool encountered an error`,
        error: error instanceof Error ? error.message : String(error),
      };
  }
}

/**
 * Convert tool output to Document objects for use in RAG pipeline
 */
async function convertToolOutputToDocuments(
  toolName: string,
  toolOutput: any,
  query: string
): Promise<Document[]> {
  const logger = getLogger().child({ function: 'convertToolOutputToDocuments' });

  try {
    // Handle different output types based on the tool
    if (typeof toolOutput === 'string') {
      // Simple text output
      return [{
        id: `tool-${toolName}-${Date.now()}`,
        title: `${toolName} result`,
        body: toolOutput,
        metadata: {
          source: 'tool',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.9, // High initial score for tool outputs
          mimeType: 'text/plain',
          url: null,
          confidence: 0.9,
          semantic_similarity: 0.9,
        },
      }];
    } else if (Array.isArray(toolOutput)) {
      // Array output - create a document for each item
      return toolOutput.map((item, index) => ({
        id: `tool-${toolName}-${Date.now()}-${index}`,
        title: `${toolName} result ${index + 1}`,
        body: typeof item === 'string' ? item : JSON.stringify(item, null, 2),
        metadata: {
          source: 'tool',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.9,
          mimeType: 'text/plain',
          url: null,
          confidence: 0.9,
          semantic_similarity: 0.9,
        },
      }));
    } else if (toolOutput && typeof toolOutput === 'object') {
      // Object output - create one document with JSON representation
      // Or split into multiple documents if it has sensible properties
      const documents: Document[] = [];

      // Handle objects with specific structures based on tool type
      if (toolOutput.content || toolOutput.data) {
        // Common API response pattern
        const mainContent = toolOutput.content || toolOutput.data;
        documents.push({
          id: `tool-${toolName}-${Date.now()}`,
          title: toolOutput.title || `${toolName} result`,
          body: typeof mainContent === 'string' ? mainContent : JSON.stringify(mainContent, null, 2),
          metadata: {
            source: 'tool',
            createdAt: new Date().toISOString(),
            relevanceScore: 0.9,
            mimeType: typeof mainContent === 'string' ? 'text/plain' : 'application/json',
            url: null,
            confidence: 0.9,
            semantic_similarity: 0.9,
          },
        });
      } else {
        // Generic object - create a single document
        documents.push({
          id: `tool-${toolName}-${Date.now()}`,
          title: `${toolName} result`,
          body: JSON.stringify(toolOutput, null, 2),
          metadata: {
            source: 'tool',
            createdAt: new Date().toISOString(),
            relevanceScore: 0.9,
            mimeType: 'application/json',
            url: null,
            confidence: 0.9,
            semantic_similarity: 0.9,
          },
        });
      }

      return documents;
    }

    // Default case - create a simple document with stringified output
    return [{
      id: `tool-${toolName}-${Date.now()}`,
      title: `${toolName} result`,
      body: typeof toolOutput === 'undefined' ? 'No output' : String(toolOutput),
      metadata: {
        source: 'tool',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.8,
        mimeType: 'text/plain',
        url: null,
        confidence: 0.8,
        semantic_similarity: 0.8,
      },
    }];
  } catch (error) {
    logger.error(
      {
        err: error,
        toolName,
      },
      'Error converting tool output to documents',
    );

    // Return a document with error information so the conversation can continue
    return [{
      id: `tool-${toolName}-error-${Date.now()}`,
      title: `${toolName} result (error)`,
      body: `The tool execution completed but there was an error processing the results: ${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        source: 'tool',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.5, // Lower score for error outputs
        mimeType: 'text/plain',
        url: null,
        confidence: 0.5,
        semantic_similarity: 0.5,
      },
    }];
  }
}

/**
 * Score tool documents for relevance to the query
 */
async function scoreToolDocuments(documents: Document[], query: string): Promise<Document[]> {
  // TODO: use real embedding based scoring
  // Calculate relevance based on query terms appearing in the document
  const queryTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 3);

  return documents.map(doc => {
    // Start with the base relevance score already in the document
    let baseScore = doc.metadata.relevanceScore || 0.8;

    // If we have query terms, adjust the score based on term matches
    if (queryTerms.length > 0) {
      const content = doc.body.toLowerCase();
      let termMatches = 0;

      for (const term of queryTerms) {
        if (content.includes(term)) {
          termMatches++;
        }
      }

      // Calculate match percentage and use it to adjust the score
      const matchPercentage = termMatches / queryTerms.length;
      const queryBoost = matchPercentage * 0.2; // Max 0.2 boost based on query match

      // Combine base score with query boost, keeping within 0-1 range
      baseScore = Math.min(baseScore + queryBoost, 1);
    }

    // Return document with updated relevance score
    return {
      ...doc,
      metadata: {
        ...doc.metadata,
        relevanceScore: baseScore,
      },
    };
  });
}
