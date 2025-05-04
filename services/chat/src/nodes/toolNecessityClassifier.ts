import { getLogger } from '@dome/common';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState, ToolNecessityClassification } from '../types';
import { ObservabilityService } from '../services/observabilityService';
import { ModelFactory } from '../services/modelFactory';
import { toDomeError } from '../utils/errors';

/**
 * Tool Necessity Classifier Node
 * 
 * Determines if external tools are necessary based on retrieval quality.
 * This node analyzes the retrieval evaluation results and makes a binary decision
 * on whether to invoke external tools to supplement the retrieved information.
 * 
 * The node:
 * 1. Takes the retrieval evaluation from the retrievalEvaluatorLLM node
 * 2. Makes a clear binary decision on tool necessity with explicit reasoning
 * 3. Updates agent state with the tool necessity classification
 * 
 * This classification is critical for determining the next steps in the RAG pipeline:
 * either proceeding directly to answer generation using retrieved content,
 * or invoking external tools to gather supplementary information.
 * 
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with tool necessity classification
 */
export async function toolNecessityClassifier(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'toolNecessityClassifier' });
  
  // Skip if no retrieval evaluation available
  if (!state.retrievalEvaluation) {
    logger.info("No retrieval evaluation found to classify tool necessity");
    return {
      metadata: {
        currentNode: "toolNecessityClassifier",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolNecessityClassifier: 0
        }
      }
    };
  }
  
  // Extract last user message to use as context
  const lastUserMessage = [...state.messages].reverse().find(msg => msg.role === 'user');
  if (!lastUserMessage) {
    logger.warn("No user message found for tool necessity classification");
    return {
      metadata: {
        currentNode: "toolNecessityClassifier",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolNecessityClassifier: 0
        }
      }
    };
  }
  
  const query = lastUserMessage.content;
  
  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "toolNecessityClassifier", state);
  
  try {
    const { isAdequate, overallScore, reasoning, suggestedAction } = state.retrievalEvaluation;
    
    logger.info({
      query,
      retrievalScore: overallScore,
      retrievalAdequate: isAdequate,
      suggestedAction
    }, "Starting tool necessity classification");
    
    // In simple cases, we can make a direct decision based on the retrieval evaluation
    if (suggestedAction === 'proceed' && isAdequate && overallScore > 0.7) {
      // If retrieval was highly adequate, we can use a fast path without LLM call
      const classification: ToolNecessityClassification = {
        isToolNeeded: false,
        reasoning: "Retrieved information is highly relevant and adequate. No external tools needed.",
        confidence: 0.9
      };
      
      logger.info({
        isToolNeeded: classification.isToolNeeded,
        confidence: classification.confidence
      }, "Tool necessity classification completed (fast path)");
      
      const elapsed = performance.now() - t0;
      
      ObservabilityService.endSpan(
        env,
        traceId,
        spanId,
        "toolNecessityClassifier",
        state,
        { ...state, toolNecessityClassification: classification },
        elapsed
      );
      
      return {
        toolNecessityClassification: classification,
        metadata: {
          currentNode: "toolNecessityClassifier",
          executionTimeMs: elapsed,
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            toolNecessityClassifier: elapsed
          }
        }
      };
    }
    
    // For more complex or borderline cases, use LLM for a more nuanced decision
    // Build classification prompt
    const systemPrompt = `You are a tool necessity classifier for a Retrieval Augmented Generation system.
Your task is to determine if external tools are necessary to supplement the retrieved information.

USER QUERY: ${query}

RETRIEVAL EVALUATION:
- Overall Relevance Score: ${overallScore * 10}/10
- Information Adequacy: ${isAdequate ? 'ADEQUATE' : 'INADEQUATE'}
- Suggested Action: ${suggestedAction}
- Reasoning: ${reasoning}

Consider these factors in your decision:
1. The relevance and completeness of retrieved information
2. Whether the query asks for real-time, external, or specialized information
3. If the user explicitly requests using an external tool
4. Whether additional context would significantly improve the answer quality

Make a binary decision: either tools ARE NEEDED or tools ARE NOT NEEDED.
Provide clear reasoning for your decision and a confidence score (0-1).

Format your response as:
DECISION: [Tools are needed/Tools are not needed]
CONFIDENCE: [0.0-1.0]
REASONING: [Your explanation]`;

    // Call LLM for classification
    const model = ModelFactory.createChatModel(env, {
      temperature: 0.2,
      maxTokens: 500,
      modelId: 'gpt-3.5-turbo' // Using a faster model for this decision
    });
    
    const modelResult = await model.invoke([
      { role: 'system', content: systemPrompt }
    ]);
    
    const classificationText = modelResult.text;
    
    // Parse the classification
    const decisionMatch = classificationText.match(/DECISION:\s*(Tools are needed|Tools are not needed)/i);
    const confidenceMatch = classificationText.match(/CONFIDENCE:\s*(0\.\d+|1\.0|1)/i);
    const reasoningMatch = classificationText.match(/REASONING:\s*([\s\S]+)$/i);
    
    const isToolNeeded = decisionMatch ? 
      decisionMatch[1].toLowerCase().includes('needed') : 
      suggestedAction === 'use_tools' || !isAdequate;
    
    const confidence = confidenceMatch ? 
      parseFloat(confidenceMatch[1]) : 
      isToolNeeded ? 0.8 : 0.7;
    
    const classificationReasoning = reasoningMatch ? 
      reasoningMatch[1].trim() : 
      classificationText;
    
    // Structure the classification
    const classification: ToolNecessityClassification = {
      isToolNeeded,
      reasoning: classificationReasoning,
      confidence
    };
    
    // Log results
    logger.info({
      isToolNeeded,
      confidence
    }, "Tool necessity classification complete");
    
    // Calculate execution time
    const elapsed = performance.now() - t0;
    
    // Record LLM call in observability
    ObservabilityService.logLlmCall(
      env,
      traceId,
      spanId,
      "gpt-3.5-turbo", // Model used for classification
      [{ role: 'system', content: systemPrompt }],
      classificationText,
      elapsed,
      { prompt: systemPrompt.length / 4, completion: classificationText.length / 4 } // Rough token estimate
    );
    
    // End span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      "toolNecessityClassifier",
      state,
      { ...state, toolNecessityClassification: classification },
      elapsed
    );
    
    // Update state with classification results
    return {
      toolNecessityClassification: classification,
      metadata: {
        currentNode: "toolNecessityClassifier",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolNecessityClassifier: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in tool necessity classifier");
    
    // Format error
    const formattedError = {
      node: "toolNecessityClassifier",
      message: domeError.message,
      timestamp: Date.now()
    };
    
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env, 
      traceId, 
      spanId, 
      "toolNecessityClassifier", 
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
        currentNode: "toolNecessityClassifier",
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          toolNecessityClassifier: elapsed
        }
      }
    };
  }
}
