import { getLogger } from '@dome/logging';
import { AgentState, ToolResult } from '../types';
import { ToolRegistry } from '../tools/registry';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Execute the selected tool with proper error handling and fallback mechanisms
 */
export const runTool = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'runTool' });
  const startTime = performance.now();
  
  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'runTool', state);
  
  const toolName = state.tasks?.toolToRun;
  const toolParameters = state.tasks?.toolParameters || {};
  
  if (!toolName) {
    logger.warn({ traceId, spanId }, 'No tool specified but reached run_tool node');
    
    // End the span
    const endTime = performance.now();
    const executionTime = endTime - startTime;
    
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'runTool',
      state,
      state,
      executionTime
    );
    
    return state;
  }
  
  logger.info(
    { 
      toolName,
      toolParameters,
      query: state.tasks?.originalQuery,
      traceId,
      spanId,
    }, 
    'Running tool'
  );
  
  try {
    // Get tool from registry
    const tool = ToolRegistry.getTool(toolName);
    
    if (!tool) {
      throw new Error(`Tool ${toolName} not found in registry`);
    }
    
    // Validate tool parameters
    const validation = ToolRegistry.validateToolInput(toolName, toolParameters);
    
    if (!validation.valid) {
      throw new Error(`Invalid tool parameters: ${validation.error}`);
    }
    
    // Execute tool with timeout and retry logic
    const toolOutput = await executeToolWithRetry(
      tool.execute,
      toolParameters,
      env,
      traceId,
      spanId
    );
    
    logger.info(
      { 
        toolName,
        toolParameters,
        toolOutputPreview: typeof toolOutput === 'string' 
          ? toolOutput.substring(0, 100) 
          : 'complex output',
        traceId,
        spanId,
      }, 
      'Tool execution complete'
    );
    
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
    
    // End the span
    const updatedState = {
      ...state,
      tasks: {
        ...state.tasks,
        toolResults: [
          ...(state.tasks?.toolResults || []),
          toolResult,
        ],
      },
    };
    
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'runTool',
      state,
      updatedState,
      executionTime
    );
    
    // Log the tool execution event
    ObservabilityService.logEvent(
      env,
      traceId,
      spanId,
      'tool_execution_complete',
      {
        toolName,
        executionTimeMs: executionTime,
        hasOutput: !!toolOutput,
      }
    );
    
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
        toolName,
        toolParameters,
        traceId,
        spanId,
      }, 
      'Error executing tool'
    );
    
    // Try to use a fallback mechanism if available
    const fallbackResult = await tryFallbackMechanism(
      toolName,
      toolParameters,
      error,
      env,
      traceId,
      spanId
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
    
    // End the span with error
    const updatedState = {
      ...state,
      tasks: {
        ...state.tasks,
        toolResults: [
          ...(state.tasks?.toolResults || []),
          toolResult,
        ],
      },
    };
    
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'runTool',
      state,
      updatedState,
      executionTime
    );
    
    // Log the error event
    ObservabilityService.logEvent(
      env,
      traceId,
      spanId,
      'tool_execution_error',
      {
        toolName,
        error: error instanceof Error ? error.message : String(error),
        hasFallbackResult: !!fallbackResult,
        executionTimeMs: executionTime,
      }
    );
    
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
  spanId: string
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
          setTimeout(() => reject(new Error('Tool execution timed out')), timeout)
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
        'Tool execution failed, retrying'
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
  spanId: string
): Promise<any> {
  const logger = getLogger().child({ function: 'tryFallbackMechanism' });
  
  logger.info(
    {
      toolName,
      error: error instanceof Error ? error.message : String(error),
      traceId,
      spanId,
    },
    'Attempting fallback mechanism'
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
