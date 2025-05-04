import { getLogger, logError } from '@dome/common';
import { toDomeError } from '../utils/errors';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { AgentState } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { ObservabilityService } from '../services/observabilityService';
import { ModelFactory } from '../services/modelFactory';
import { getModelConfig, calculateTokenLimits } from '../config/modelConfig';

/**
 * Output Guardrail Node
 *
 * Validates the generated answer for accuracy, compliance, and lack of hallucination.
 * This node serves as the final quality check before delivering a response to the user.
 *
 * The node:
 * 1. Takes the generated answer, combined context, and original query
 * 2. Uses LLM-driven validation to check for factual accuracy against the context
 * 3. Identifies potential hallucinations or unsupported claims
 * 4. Provides corrective feedback and modifications if necessary
 * 5. Returns a validated (and potentially corrected) final answer
 *
 * This node ensures that responses adhere to the highest standards of
 * accuracy and quality before being presented to the user.
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment variables
 * @returns Updated agent state with validated answer
 */
export async function outputGuardrail(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ node: 'outputGuardrail' });
  logger.info('Starting answer validation');

  /* ------------------------------------------------------------------ */
  /*  Initialize tracing and observability                              */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'outputGuardrail', state);

  try {
    /* ------------------------------------------------------------------ */
    /*  Gather inputs for validation                                      */
    /* ------------------------------------------------------------------ */
    // Get the original user query
    const userQuery = state.messages[0].content;

    // Get the generated answer to validate
    const generatedAnswer = state.generatedText;
    if (!generatedAnswer) {
      throw new Error('No generated answer found to validate');
    }

    // Get the synthesized context used to generate the answer
    const synthesizedContext = state.reasoning?.[0] || '';

    /* ------------------------------------------------------------------ */
    /*  Configure the validation model                                    */
    /* ------------------------------------------------------------------ */
    // Use a model with strong reasoning capabilities for validation
    const modelId = state.options?.modelId ?? 'gpt-4-turbo';
    const modelConfig = getModelConfig(modelId);

    // Calculate token usage and limits
    const answerTokens = countTokens(generatedAnswer);
    const contextTokens = countTokens(synthesizedContext);
    const queryTokens = countTokens(userQuery);

    // Calculate token limits for validation response
    const { maxResponseTokens } = calculateTokenLimits(
      modelConfig,
      answerTokens + contextTokens + queryTokens + 1000, // Add buffer for system prompt
      state.options?.maxTokens,
    );

    /* ------------------------------------------------------------------ */
    /*  Build validation prompt                                           */
    /* ------------------------------------------------------------------ */
    const validationPrompt = `
You are an expert validation system that ensures answers are accurate, well-supported, and free from hallucination.

USER QUERY: ${userQuery}

REFERENCE CONTEXT USED:
${synthesizedContext}

GENERATED ANSWER TO VALIDATE:
${generatedAnswer}

VALIDATION INSTRUCTIONS:
1. Carefully analyze the generated answer for factual accuracy against the reference context
2. Identify any claims or statements not supported by the provided context
3. Check for any hallucinations (information not present in or contradicting the context)
4. Verify proper attribution of information sources
5. Evaluate overall quality, completeness, and relevance to the query

EXPECTED OUTPUT:
First, provide a detailed validation assessment with:
- Accuracy score (0-10)
- List of any unsupported claims or hallucinations
- Assessment of source attribution quality
- Specific passages needing correction (if any)

Then, if needed, provide a CORRECTED VERSION of the answer that:
- Removes unsupported claims
- Modifies hallucinated content
- Adds proper source attribution
- Maintains or improves clarity and completeness

If the original answer is accurate and well-supported, simply write "ORIGINAL ANSWER VALIDATED" without any corrections.
`;

    // Create the validation model
    const model = ModelFactory.createChatModel(env, {
      modelId,
      temperature: 0.2, // Lower temperature for consistent validation
      maxTokens: maxResponseTokens,
    });

    // Execute validation
    const validationResponse = await model.invoke([
      {
        role: 'user',
        content: validationPrompt,
      },
    ]);

    const validationResult = validationResponse.text;

    /* ------------------------------------------------------------------ */
    /*  Process validation result                                         */
    /* ------------------------------------------------------------------ */
    // Determine if corrections were made
    const hasCorrections = !validationResult.includes('ORIGINAL ANSWER VALIDATED');

    // Extract the corrected answer if present
    let finalAnswer = generatedAnswer;
    let validationAssessment = '';

    if (hasCorrections) {
      // Look for a corrected version marker
      const correctedVersionRegex = /CORRECTED VERSION[:\s]+(.+?)(?=$|VALIDATION ASSESSMENT)/is;
      const correctedMatch = validationResult.match(correctedVersionRegex);

      if (correctedMatch && correctedMatch[1]) {
        finalAnswer = correctedMatch[1].trim();
      } else {
        // If no explicit corrected version, use the entire validation result
        // This is a fallback
        finalAnswer = generatedAnswer;
        logger.warn('Validation indicated corrections needed but no corrected version found');
      }

      // Extract the validation assessment part
      const assessmentRegex =
        /(?:VALIDATION ASSESSMENT|ASSESSMENT):[:\s]+(.+?)(?=CORRECTED VERSION|$)/is;
      const assessmentMatch = validationResult.match(assessmentRegex);

      if (assessmentMatch && assessmentMatch[1]) {
        validationAssessment = assessmentMatch[1].trim();
      }
    }

    /* ------------------------------------------------------------------ */
    /*  Finish, log, and return the state update                          */
    /* ------------------------------------------------------------------ */
    const elapsed = performance.now() - t0;

    // Log completion
    logger.info(
      {
        elapsedMs: elapsed,
        wasModified: hasCorrections,
        assessmentLength: validationAssessment.length,
        finalAnswerLength: finalAnswer.length,
      },
      'Answer validation complete',
    );

    // End observability
    ObservabilityService.endSpan(env, traceId, spanId, 'outputGuardrail', state, state, elapsed);
    ObservabilityService.endTrace(env, traceId, state, elapsed);

    // Return state updates
    return {
      generatedText: finalAnswer, // Replace with validated/corrected answer
      metadata: {
        currentNode: 'outputGuardrail',
        isFinalState: true, // Mark this as the final node in the pipeline
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          outputGuardrail: elapsed,
        },
      },
      // Store the validation assessment in reasoning array
      reasoning: [
        ...(state.reasoning || []),
        hasCorrections
          ? `VALIDATION: Answer was corrected. ${validationAssessment}`
          : 'VALIDATION: Original answer validated.',
      ],
    };
  } catch (err) {
    // Handle errors gracefully
    const domeError = toDomeError(err);
    const elapsed = performance.now() - t0;

    // Log the error
    logError(domeError, 'Error in outputGuardrail', { traceId, spanId });

    // End span with error
    ObservabilityService.endSpan(env, traceId, spanId, 'outputGuardrail', state, state, elapsed);
    ObservabilityService.endTrace(env, traceId, state, elapsed);

    // Format error for state
    const formattedError = {
      node: 'outputGuardrail',
      message: domeError.message,
      timestamp: Date.now(),
    };

    // In case of error, use the original unvalidated answer as fallback
    const finalAnswer =
      state.generatedText ||
      "I'm sorry, but I encountered an issue validating the response to your query.";

    // Return error state update with original answer as fallback
    return {
      generatedText: finalAnswer,
      metadata: {
        currentNode: 'outputGuardrail',
        isFinalState: true,
        executionTimeMs: elapsed,
        errors: [...(state.metadata?.errors || []), formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          outputGuardrail: elapsed,
        },
      },
    };
  }
}
