import { getLogger } from '@dome/logging';
import { AgentState, Document } from '../types';
import { ToolRegistry } from '../tools/registry';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { getToolRoutingPrompt } from '../config/promptsConfig';


// Define the Message type to match the expected format
type Message = {
  role: 'user' | 'system' | 'assistant';
  content: string;
  timestamp?: number;
};

/**
 * Interface for tool selection result
 */
interface ToolSelectionResult {
  toolName: string;
  confidence: number;
  reason: string;
}

/**
 * Interface for task analysis result from LLM
 */
interface TaskAnalysisResult {
  needsTool: boolean;
  recommendedTools: string[];
  completable: boolean;
  reasoning: string;
  confidence: number;
}

/**
 * Route to appropriate tool based on query intent
 */
export const toolRouter = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'toolRouter' });
  const startTime = performance.now();

  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'toolRouter', state);

  const requiredTools = state.tasks?.requiredTools || [];

  if (requiredTools.length === 0) {
    logger.warn({ traceId, spanId }, 'No tools specified but reached tool router');

    // End the span
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'toolRouter',
      state,
      {
        ...state,
        tasks: {
          ...state.tasks,
          toolToRun: null,
        },
      },
      executionTime,
    );

    return {
      ...state,
      tasks: {
        ...state.tasks,
        toolToRun: null,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouter: executionTime,
        },
      },
    };
  }

  try {
    // Get the query for tool selection
    const query = state.tasks?.originalQuery || '';

    // Select the most appropriate tool based on query intent
    const toolSelection = await selectBestTool(env, query, requiredTools, traceId, spanId);

    logger.info(
      {
        toolToRun: toolSelection.toolName,
        confidence: toolSelection.confidence,
        reason: toolSelection.reason,
        allTools: requiredTools,
        query,
        traceId,
        spanId,
      },
      'Selected tool to run',
    );

    // Extract parameters for the selected tool
    const toolParameters = await extractToolParameters(
      env,
      query,
      toolSelection.toolName,
      traceId,
      spanId,
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'toolRouter',
      state,
      {
        ...state,
        tasks: {
          ...state.tasks,
          toolToRun: toolSelection.toolName,
          toolParameters,
          toolSelectionReason: toolSelection.reason,
          toolSelectionConfidence: toolSelection.confidence,
        },
      },
      executionTime,
    );

    // Log the tool selection event
    ObservabilityService.logEvent(env, traceId, spanId, 'tool_selected', {
      toolName: toolSelection.toolName,
      confidence: toolSelection.confidence,
      reason: toolSelection.reason,
      parameters: toolParameters,
      executionTimeMs: executionTime,
    });

    return {
      ...state,
      tasks: {
        ...state.tasks,
        toolToRun: toolSelection.toolName,
        toolParameters,
        toolSelectionReason: toolSelection.reason,
        toolSelectionConfidence: toolSelection.confidence,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouter: executionTime,
        },
      },
    };
  } catch (error) {
    // Log the error
    logger.error(
      {
        err: error,
        requiredTools,
        traceId,
        spanId,
      },
      'Error selecting tool',
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span with error
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'toolRouter',
      state,
      {
        ...state,
        tasks: {
          ...state.tasks,
          toolToRun: null,
          toolError: error instanceof Error ? error.message : String(error),
        },
      },
      executionTime,
    );

    // Log the error event
    ObservabilityService.logEvent(env, traceId, spanId, 'tool_selection_error', {
      error: error instanceof Error ? error.message : String(error),
      requiredTools,
      executionTimeMs: executionTime,
    });

    // Fall back to the first tool in the list if available
    const fallbackTool = requiredTools.length > 0 ? requiredTools[0] : null;

    return {
      ...state,
      tasks: {
        ...state.tasks,
        toolToRun: fallbackTool,
        toolError: error instanceof Error ? error.message : String(error),
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouter: executionTime,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'toolRouter',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};

/**
 * Determine next step after tool routing
 */
export const routeAfterTool = (state: AgentState): 'run_tool' | 'answer' => {
  const logger = getLogger().child({ node: 'routeAfterTool' });
  
  const toolToRun = state.tasks?.toolToRun;
  const toolResults = state.tasks?.toolResults || [];
  
  // If a tool is selected, route to run_tool
  if (toolToRun) {
    logger.info({
      toolToRun,
      previousToolCount: toolResults.length,
    }, 'Routing to run_tool');
    return 'run_tool';
  }
  
  // Otherwise, route to answer generation
  logger.info({
    toolToRun,
    previousToolCount: toolResults.length,
  }, 'Routing directly to answer generation');
  return 'answer';
};

/**
 * Select the best tool based on query intent
 * @param env Environment bindings
 * @param query User query
 * @param availableTools List of available tools
 * @param traceId Trace ID for observability
 * @param spanId Span ID for observability
 * @returns Selected tool name and confidence score
 */
/**
 * Analyze the task to determine if tools are needed and which ones would be most appropriate
 */
async function analyzeTaskForTools(
  env: Env,
  query: string,
  retrievedDocs: Document[],
  availableTools: string[],
  traceId: string,
  spanId: string
): Promise<TaskAnalysisResult> {
  const logger = getLogger().child({ function: 'analyzeTaskForTools' });

  // If no tools are available, return early
  if (availableTools.length === 0) {
    return {
      needsTool: false,
      recommendedTools: [],
      completable: true,
      reasoning: "No tools available for this task.",
      confidence: 1.0
    };
  }

  try {
    // Get tool descriptions for context
    const toolDescriptions = availableTools
      .map(toolName => {
        const tool = ToolRegistry.getTool(toolName);
        if (!tool) {
          return `${toolName}: No description available`;
        }
        return `${toolName}: ${tool.description}`;
      })
      .join('\n');

    // Create a summary of the retrieved documents for context
    const docsSummary = retrievedDocs.length > 0
      ? retrievedDocs.slice(0, 3).map(doc => `- ${doc.title}: ${doc.body.substring(0, 100)}...`).join('\n')
      : "No documents retrieved.";

    // Create a prompt for the LLM to analyze if tools are needed
    const systemPrompt = getToolRoutingPrompt()
      .replace('{toolDescriptions}', toolDescriptions)
      .replace('{docsSummary}', docsSummary);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `User query: "${query}"` },
    ];

    // Call the LLM to analyze the task
    // @ts-ignore - Ignoring type errors for now to make progress
    const response = await LlmService.call(env, messages as Message[], {});

    // Parse the response as JSON
    try {
      const result = JSON.parse(response);

      // Validate the result
      if (typeof result.needsTool !== 'boolean') {
        throw new Error(`Invalid task analysis: missing needsTool property`);
      }

      // Normalize the recommended tools to ensure they exist
      const recommendedTools = Array.isArray(result.recommendedTools)
        ? result.recommendedTools.filter((tool: string) => availableTools.includes(tool))
        : [];

      // Ensure confidence is a number between 0 and 1
      const confidence = typeof result.confidence === 'number'
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;

      return {
        needsTool: result.needsTool,
        recommendedTools,
        completable: result.completable === false ? false : true, // Default to true if not specified
        reasoning: result.reasoning || 'No reasoning provided',
        confidence,
      };
    } catch (parseError) {
      logger.error(
        {
          err: parseError,
          response,
          traceId,
          spanId,
        },
        'Failed to parse task analysis response'
      );

      // Fall back to a simple heuristic
      return {
        needsTool: availableTools.length > 0,
        recommendedTools: availableTools,
        completable: true,
        reasoning: 'Failed to parse LLM response, using fallback analysis',
        confidence: 0.5,
      };
    }
  } catch (error) {
    logger.error(
      {
        err: error,
        query,
        availableTools,
        traceId,
        spanId,
      },
      'Error analyzing task for tools'
    );

    // Fall back to a simple heuristic
    return {
      needsTool: availableTools.length > 0,
      recommendedTools: availableTools,
      completable: true,
      reasoning: 'Error during task analysis, using fallback',
      confidence: 0.5,
    };
  }
}

/**
 * Select the best tool based on query intent and task analysis
 */
async function selectBestTool(
  env: Env,
  query: string,
  availableTools: string[],
  traceId: string,
  spanId: string,
): Promise<ToolSelectionResult> {
  const logger = getLogger().child({ function: 'selectBestTool' });

  // If only one tool is available, return it
  if (availableTools.length === 1) {
    return {
      toolName: availableTools[0],
      confidence: 1.0,
      reason: 'Only one tool available',
    };
  }

  try {
    // Get tool descriptions for context
    const toolDescriptions = availableTools
      .map(toolName => {
        const tool = ToolRegistry.getTool(toolName);
        if (!tool) {
          return `${toolName}: No description available`;
        }
        return `${toolName}: ${tool.description}`;
      })
      .join('\n');

    // Create a prompt for the LLM to select the best tool
    const systemPrompt = `You are an AI assistant that helps select the most appropriate tool based on a user query.
Given the following tools and a user query, select the best tool to use.

Available tools:
${toolDescriptions}

Analyze the query carefully and select the tool that best matches the user's intent.
Respond with a JSON object containing:
- toolName: the name of the selected tool
- confidence: a number between 0 and 1 indicating your confidence in the selection
- reason: a brief explanation of why you selected this tool

Only respond with the JSON object, no other text.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `User query: "${query}"` },
    ];

    // Call the LLM to select the best tool
    // @ts-ignore - Ignoring type errors for now to make progress
    const response = await LlmService.call(env, messages as Message[], { traceId, spanId });

    // Parse the response as JSON
    try {
      const result = JSON.parse(response);

      // Validate the result
      if (!result.toolName || !availableTools.includes(result.toolName)) {
        throw new Error(`Invalid tool selection: ${result.toolName}`);
      }

      // Ensure confidence is a number between 0 and 1
      const confidence =
        typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.5;

      return {
        toolName: result.toolName,
        confidence,
        reason: result.reason || 'No reason provided',
      };
    } catch (parseError) {
      logger.error(
        {
          err: parseError,
          response,
          traceId,
          spanId,
        },
        'Failed to parse tool selection response',
      );

      // Fall back to the first tool
      return {
        toolName: availableTools[0],
        confidence: 0.5,
        reason: 'Failed to parse LLM response, falling back to first tool',
      };
    }
  } catch (error) {
    logger.error(
      {
        err: error,
        query,
        availableTools,
        traceId,
        spanId,
      },
      'Error selecting tool with LLM',
    );

    // Fall back to the first tool
    return {
      toolName: availableTools[0],
      confidence: 0.5,
      reason: 'Error during tool selection, falling back to first tool',
    };
  }
}

/**
 * Extract parameters for a tool from the query
 * @param env Environment bindings
 * @param query User query
 * @param toolName Tool name
 * @param traceId Trace ID for observability
 * @param spanId Span ID for observability
 * @returns Extracted parameters
 */
async function extractToolParameters(
  env: Env,
  query: string,
  toolName: string,
  traceId: string,
  spanId: string,
): Promise<Record<string, any>> {
  const logger = getLogger().child({ function: 'extractToolParameters' });

  // Get the tool definition
  const tool = ToolRegistry.getTool(toolName);

  if (!tool) {
    logger.warn(
      {
        toolName,
        traceId,
        spanId,
      },
      'Tool not found in registry',
    );
    return {};
  }

  // If the tool has no parameters, return empty object
  if (tool.parameters.length === 0) {
    return {};
  }

  try {
    // Create a prompt for the LLM to extract parameters
    const paramDescriptions = tool.parameters
      .map(
        param =>
          `- ${param.name} (${param.type}${param.required ? ', required' : ''}): ${
            param.description
          }`,
      )
      .join('\n');

    const systemPrompt = `You are an AI assistant that extracts parameters for tools from user queries.
Given a user query and a tool with its parameters, extract the parameter values from the query.

Tool: ${tool.name}
Description: ${tool.description}
Parameters:
${paramDescriptions}

Extract the parameter values from the user query and respond with a JSON object where the keys are the parameter names and the values are the extracted values.
If a parameter is not mentioned in the query and is not required, omit it from the response.
If a required parameter is not mentioned, make a reasonable guess based on the query context.
Ensure the parameter types match the expected types.

Only respond with the JSON object, no other text.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `User query: "${query}"` },
    ];

    // Call the LLM to extract parameters
    // @ts-ignore - Ignoring type errors for now to make progress
    const response = await LlmService.call(env, messages as Message[], { traceId, spanId });

    // Parse the response as JSON
    try {
      const parameters = JSON.parse(response);

      // Apply default values for missing parameters
      tool.parameters.forEach(param => {
        if (parameters[param.name] === undefined && param.default !== undefined) {
          parameters[param.name] = param.default;
        }
      });

      return parameters;
    } catch (parseError) {
      logger.error(
        {
          err: parseError,
          response,
          toolName,
          traceId,
          spanId,
        },
        'Failed to parse parameter extraction response',
      );

      // Return default parameters
      return tool.parameters.reduce((params, param) => {
        if (param.default !== undefined) {
          params[param.name] = param.default;
        }
        return params;
      }, {} as Record<string, any>);
    }
  } catch (error) {
    logger.error(
      {
        err: error,
        query,
        toolName,
        traceId,
        spanId,
      },
      'Error extracting parameters with LLM',
    );

    // Return default parameters
    return tool.parameters.reduce((params, param) => {
      if (param.default !== undefined) {
        params[param.name] = param.default;
      }
      return params;
    }, {} as Record<string, any>);
  }
}
