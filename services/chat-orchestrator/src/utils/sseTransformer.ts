import { getLogger, logError } from '@dome/logging';
import { AgentState } from '../types';

/**
 * Transform graph output to SSE events
 * @param stream AsyncIterable from LangGraph execution
 * @param startTime Start time for performance measurement
 * @returns ReadableStream of SSE events
 */
// Using any to accommodate the type mismatch between LangGraph's stream and AgentState
export function transformToSSE(stream: any, startTime: number): ReadableStream {
  const encoder = new TextEncoder();
  const logger = getLogger().child({ component: 'SSETransformer' });

  return new ReadableStream({
    async start(controller) {
      try {
        // Process each state update from the LangGraph stream
        for await (const state of stream) {
          // Send workflow step event
          if (state.metadata?.currentNode) {
            const stepEvent = `event: workflow_step\ndata: ${JSON.stringify({
              step: state.metadata.currentNode,
            })}\n\n`;
            controller.enqueue(encoder.encode(stepEvent));
          }

          // Send sources event if docs are available
          if (state.docs && state.docs.length > 0) {
            const sources = state.docs?.map((doc: any) => ({
              id: doc.id,
              title: doc.title,
              source: doc.metadata.source,
              url: doc.metadata.url,
              relevanceScore: doc.metadata.relevanceScore,
            })) || [];

            // Send sources event
            const sourcesEvent = `event: sources\ndata: ${JSON.stringify(sources)}\n\n`;
            controller.enqueue(encoder.encode(sourcesEvent));
          }

          // Send generated text event if available
          if (state.generatedText) {
            const textEvent = `event: text\ndata: ${JSON.stringify({
              text: state.generatedText,
            })}\n\n`;
            controller.enqueue(encoder.encode(textEvent));
          }

          // Send final event if this is the final state
          if (state.metadata?.isFinalState) {
            const executionTime = performance.now() - startTime;
            const finalEvent = `event: final\ndata: ${JSON.stringify({
              executionTimeMs: Math.round(executionTime),
            })}\n\n`;
            controller.enqueue(encoder.encode(finalEvent));
          }
        }

        // Send end event
        const endEvent = `event: end\ndata: {}\n\n`;
        controller.enqueue(encoder.encode(endEvent));
        controller.close();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error({ err: error }, 'Error streaming SSE events');

        // Send error event
        const errorEvent = `event: error\ndata: ${JSON.stringify({
          message: errorMessage,
        })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
        controller.close();
      }
    },
  });
}

/**
 * Create error response stream
 * @param error Error object
 * @returns ReadableStream with error event
 */
export function createErrorStream(error: unknown): ReadableStream {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const errorEvent = `event: error\ndata: ${JSON.stringify({
        message: errorMessage,
      })}\n\n`;
      controller.enqueue(encoder.encode(errorEvent));
      controller.close();
    },
  });
}