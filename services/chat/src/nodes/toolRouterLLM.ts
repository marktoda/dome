import { getLogger } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState, ToolRoutingDecision } from '../types';
import { ObservabilityService } from '../services/observabilityService';
import { ModelFactory } from '../services/modelFactory';
import { toDomeError } from '../utils/errors';
import { ToolRegistry } from "../tools";
import { z } from "zod";

/**
 * Tool Router LLM Node
 * 
 * Selects appropriate external tools based on task context and necessity.
 * This node analyzes the user query, retrieval results, and tool necessity
 * classification to intelligently select which external tools to use.
 * 
 * The node:
 * 1. Takes the tool necessity classification from the toolNecessityClassifier node
 * 2. Only executes if tools are deemed necessary
 * 3. Selects the most appropriate tool(s) and prepares parameters for execution
 * 4. Updates agent state with the tool routing decision
 * 
 * This node leverages an LLM to make contextually appropriate tool selection
 * decisions based on the available tools in the registry and the specific
 * information needs identified in the retrieval evaluation.
 * 
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @param registry Tool registry containing available tools
 * @returns Updated agent state with tool routing decision
 */
export async function toolRouterLLM(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
  registry: ToolRegistry,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'toolRouterLLM' });
  
  // Skip if no tool necessity classification available or tools not needed
  if (!state.toolNecessityClassification || !state.toolNecessityClassification.isToolNeeded) {
    logger.info("Tools not needed or no classification available, skipping tool routing");
    return {
      metadata: {
        currentNode: "toolRouterLLM",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouterLLM: 0
        }
      }
    };
  }
  
  // Extract last user message to use as context
  const lastUserMessage = [...state.messages].reverse().find(msg => msg.role === 'user');
  if (!lastUserMessage) {
    logger.warn("No user message found for tool routing");
    return {
      metadata: {
        currentNode: "toolRouterLLM",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouterLLM: 0
        }
      }
    };
  }
  
  const query = lastUserMessage.content;
  
  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "toolRouterLLM", state);
  
  try {
    // Get available tools from registry
    const availableTools = registry.list();
    
    // Skip if no tools are available
    if (availableTools.length === 0) {
      logger.info("No tools available in registry");
      
      const noToolsDecision: ToolRoutingDecision = {
        selectedTool: null,
        parameters: {},
        reasoning: "No tools are available in the tool registry.",
        confidence: 1.0
      };
      
      const elapsed = performance.now() - t0;
      
      ObservabilityService.endSpan(
        env,
        traceId,
        spanId,
        "toolRouterLLM",
        state,
        { ...state, toolRoutingDecision: noToolsDecision },
        elapsed
      );
      
      return {
        toolRoutingDecision: noToolsDecision,
        metadata: {
          currentNode: "toolRouterLLM",
          executionTimeMs: elapsed,
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            toolRouterLLM: elapsed
          }
        }
      };
    }
    
    logger.info({
      query,
      availableToolCount: availableTools.length,
      toolNecessityReasoning: state.toolNecessityClassification.reasoning
    }, "Starting tool routing");
    
    // Prepare tools description
    const toolsDescription = availableTools
      .map(tool => {
        return `### ${tool.name}
Description: ${tool.description}
Parameters: ${tool.description.includes('Parameters:') ?
  tool.description.split('Parameters:')[1].trim() :
  'No parameters details available'}`;
      })
      .join('\n\n');
    
    // Build routing prompt
    const systemPrompt = `You are a tool selection expert for a Retrieval Augmented Generation system.
Your task is to select the most appropriate tool to answer the user's query based on the context provided.

USER QUERY: ${query}

RETRIEVAL CONTEXT:
${state.retrievalEvaluation ? 
  `- Retrieval adequacy: ${state.retrievalEvaluation.isAdequate ? 'ADEQUATE' : 'INADEQUATE'}
- Retrieval overall score: ${state.retrievalEvaluation.overallScore * 10}/10
- Retrieval reasoning: ${state.retrievalEvaluation.reasoning}` : 
  'No retrieval evaluation available'}

TOOL NECESSITY:
- Tools needed: ${state.toolNecessityClassification.isToolNeeded ? 'YES' : 'NO'}
- Confidence: ${state.toolNecessityClassification.confidence}
- Reasoning: ${state.toolNecessityClassification.reasoning}

AVAILABLE TOOLS:
${toolsDescription}

Your job is to:
1. Determine which tool, if any, is most appropriate for this query
2. Provide parameters for the selected tool based on the user query
3. Provide a confidence score for your selection (0-1)
4. Explain your reasoning

If no tool is appropriate, return null for the selectedTool.

Format your response as JSON:
{
  "selectedTool": "[tool name or null]",
  "parameters": {
    // Tool-specific parameters based on the schema
  },
  "confidence": [0.0-1.0],
  "reasoning": "[your explanation]"
}`;

    // Call LLM for tool routing
    const model = ModelFactory.createChatModel(env, {
      temperature: 0.3,
      maxTokens: 800,
      modelId: 'gpt-4' // Using GPT-4 for better parameter handling
    });
    
    const modelResult = await model.invoke([
      { role: 'system', content: systemPrompt }
    ]);
    
    const routingText = modelResult.text;
    
    // Parse the tool routing decision
    let routingDecision: ToolRoutingDecision;
    
    try {
      // Try to parse the JSON response directly
      const jsonMatch = routingText.match(/```json\s*([\s\S]*?)\s*```|^\s*(\{[\s\S]*\})\s*$/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : routingText;
      routingDecision = JSON.parse(jsonStr.trim());
      
      // Validate the structure
      if (typeof routingDecision.selectedTool !== 'string' && routingDecision.selectedTool !== null) {
        throw new Error('Invalid selectedTool format');
      }
      
      if (typeof routingDecision.parameters !== 'object') {
        routingDecision.parameters = {};
      }
      
      if (typeof routingDecision.confidence !== 'number') {
        routingDecision.confidence = 0.5;
      }
      
      if (typeof routingDecision.reasoning !== 'string') {
        routingDecision.reasoning = 'No reasoning provided';
      }
    } catch (parseError) {
      // Fallback to extraction if JSON parsing fails
      logger.warn({ err: parseError }, "Failed to parse JSON response, falling back to extraction");
      
      const toolMatch = routingText.match(/selectedTool["\s:]+([^"\s,}]+)|tool[:\s]+"?([^"\s,}]+)/i);
      const selectedTool = toolMatch ? (toolMatch[1] || toolMatch[2]) : null;
      
      // Basic parameters extraction - this is a simplified fallback
      const parametersMatch = routingText.match(/parameters["\s:]+(\{[\s\S]*?\})/);
      let parameters = {};
      if (parametersMatch) {
        try {
          parameters = JSON.parse(parametersMatch[1]);
        } catch (e) {
          // Keep empty parameters if parsing fails
        }
      }
      
      const confidenceMatch = routingText.match(/confidence["\s:]+([0-9.]+)/i);
      const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;
      
      const reasoningMatch = routingText.match(/reasoning["\s:]+["'](.+?)["']/i);
      const reasoning = reasoningMatch ? 
        reasoningMatch[1] : 
        "Extracted reasoning from unstructured response";
      
      routingDecision = {
        selectedTool: selectedTool,
        parameters,
        confidence,
        reasoning
      };
    }
    
    // Ensure tool exists in registry if one was selected
    if (routingDecision.selectedTool) {
      const toolExists = availableTools.some(tool => tool.name === routingDecision.selectedTool);
      
      if (!toolExists) {
        logger.warn({
          selectedTool: routingDecision.selectedTool
        }, "Selected tool not found in registry, defaulting to null");
        
        routingDecision.selectedTool = null;
        routingDecision.parameters = {};
        routingDecision.confidence = 0;
        routingDecision.reasoning += " (Note: The originally selected tool was not found in the registry)";
      } else {
        // Validate parameters against tool schema if a tool was selected
        try {
          const tool = registry.get(routingDecision.selectedTool);
          if (tool) {
            // Add task ID to parameters, as it seems to be expected by the tool execution system
            const taskIds = state.taskIds || ['default-task-id'];
            const taskId = taskIds[0]; // Using the first task ID by default
            
            // Prepare entities for tool execution
            const taskEntities = {
              ...state.taskEntities,
              [taskId]: {
                ...(state.taskEntities?.[taskId] || {}),
                id: taskId,
                toolToRun: routingDecision.selectedTool,
                toolParameters: routingDecision.parameters,
                toolSelectionReason: routingDecision.reasoning,
                toolSelectionConfidence: routingDecision.confidence
              }
            };
            
            // Return the task entities for the runTool node
            const elapsed = performance.now() - t0;
            
            ObservabilityService.endSpan(
              env,
              traceId,
              spanId,
              "toolRouterLLM",
              state,
              { 
                ...state, 
                toolRoutingDecision: routingDecision,
                taskEntities
              },
              elapsed
            );
            
            return {
              toolRoutingDecision: routingDecision,
              taskEntities,
              taskIds: taskIds.includes(taskId) ? taskIds : [...taskIds, taskId],
              metadata: {
                currentNode: "toolRouterLLM",
                executionTimeMs: elapsed,
                nodeTimings: {
                  ...state.metadata?.nodeTimings,
                  toolRouterLLM: elapsed
                }
              }
            };
          }
        } catch (validationError) {
          logger.warn({ err: validationError }, "Parameter validation failed");
        }
      }
    }
    
    // Log results
    logger.info({
      selectedTool: routingDecision.selectedTool,
      confidence: routingDecision.confidence
    }, "Tool routing decision complete");
    
    // Calculate execution time
    const elapsed = performance.now() - t0;
    
    // Record LLM call in observability
    ObservabilityService.logLlmCall(
      env,
      traceId,
      spanId,
      "gpt-4", // Model used for routing
      [{ role: 'system', content: systemPrompt }],
      routingText,
      elapsed,
      { prompt: systemPrompt.length / 4, completion: routingText.length / 4 } // Rough token estimate
    );
    
    // End span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      "toolRouterLLM",
      state,
      { ...state, toolRoutingDecision: routingDecision },
      elapsed
    );
    
    // Update state with routing decision
    return {
      toolRoutingDecision: routingDecision,
      metadata: {
        currentNode: "toolRouterLLM",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouterLLM: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in tool router LLM");
    
    // Format error
    const formattedError = {
      node: "toolRouterLLM",
      message: domeError.message,
      timestamp: Date.now()
    };
    
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env, 
      traceId, 
      spanId, 
      "toolRouterLLM", 
      state, 
      { 
        ...state, 
        metadata: { 
          ...state.metadata, 
          errors: [
            ...(state.metadata?.errors || []),
            formattedError
          ] 
        } 
      }, 
      elapsed
    );
    
    return {
      metadata: {
        currentNode: "toolRouterLLM",
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolRouterLLM: elapsed
        }
      }
    };
  }
}