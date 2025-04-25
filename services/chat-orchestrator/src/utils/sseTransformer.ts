import { getLogger } from '@dome/logging';
import { AgentState, Document } from '../types';

/**
 * Transform graph output to SSE events
 */
export function transformToSSE(stream: AsyncIterable<AgentState>): ReadableStream {
  const logger = getLogger().child({ component: 'sseTransformer' });
  
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      
      try {
        for await (const state of stream) {
          // Determine event type based on state
          if (state.metadata?.currentNode) {
            // Send workflow step event
            const stepEvent = `event: workflow_step\ndata: ${JSON.stringify({
              step: state.metadata.currentNode,
            })}\n\n`;
            controller.enqueue(encoder.encode(stepEvent));
          }
          
          // If we have generated text, send answer event
          if (state.generatedText) {
            // Extract sources from docs if available
            const sources = state.docs?.map(doc => ({
              id: doc.id,
              title: doc.title,
              source: doc.metadata.source,
            })) || [];
            
            const answerEvent = `event: answer\ndata: ${JSON.stringify({
              delta: state.generatedText,
              sources: state.options.includeSourceInfo ? sources : [],
            })}\n\n`;
            controller.enqueue(encoder.encode(answerEvent));
          }
          
          // If this is the final state, send done event
          if (state.metadata?.isFinalState) {
            const doneEvent = `event: done\ndata: ${JSON.stringify({
              executionTimeMs: getTotalExecutionTime(state),
            })}\n\n`;
            controller.enqueue(encoder.encode(doneEvent));
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Error in SSE stream transformation');
        
        // Send error event
        const errorEvent = `event: error\ndata: ${JSON.stringify({
          message: 'An error occurred during processing',
        })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Calculate total execution time from node timings
 */
function getTotalExecutionTime(state: AgentState): number {
  const nodeTimings = state.metadata?.nodeTimings || {};
  return Object.values(nodeTimings).reduce((sum, time) => sum + time, 0);
}