import { getLogger, logError } from '@dome/common';
import { AgentState } from '../types';
import { processThinkingContent } from './thinkingHandler';

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

  // Store accumulated content
  let accumulatedText = '';
  let sources: any[] = [];
  let stateCount = 0;
  let finalExecutionTime = 0;
  let lastNodeName = '';

  return new ReadableStream({
    async start(controller) {
      try {
        logger.info('Starting SSE transformation with message streaming mode');

        // Process each event from the LangGraph stream
        for await (const event of stream) {
          stateCount++;

          // Log information about the event for debugging
          logger.debug(
            {
              eventNumber: stateCount,
              eventType: event.event,
              eventName: event.name,
              metadata: event.metadata,
              hasData: !!event.data,
              dataKeys: event.data ? Object.keys(event.data) : [],
            },
            '[SSETransformer] Processing event',
          );

          // Handle different event types
          if (event.event === 'on_chat_model_stream') {
            // This is a token-level streaming event from the LLM
            try {
              // Extract the token chunk
              const chunk = event.data?.chunk;
              if (chunk && chunk.content) {
                // Check if this might be thinking content
                const isThinking =
                  chunk.content.includes('<thinking>') || accumulatedText.includes('<thinking>');

                // Process the content appropriately
                const processedContent = processThinkingContent(chunk.content);
                accumulatedText += processedContent;

                // Send the updated text to the client
                logger.debug(
                  {
                    chunkLength: chunk.content.length,
                    isThinking,
                    totalLength: accumulatedText.length,
                  },
                  '[SSETransformer] Sending token chunk',
                );

                // If it's thinking content, send as a thinking event
                if (isThinking) {
                  const thinkingEvent = `event: thinking\ndata: ${JSON.stringify({
                    thinking: accumulatedText,
                  })}\n\n`;
                  controller.enqueue(encoder.encode(thinkingEvent));
                } else {
                  // Otherwise send as regular text event
                  const textEvent = `event: text\ndata: ${JSON.stringify({
                    text: accumulatedText,
                  })}\n\n`;
                  controller.enqueue(encoder.encode(textEvent));
                }
              }
            } catch (e) {
              logger.warn(
                {
                  error: e,
                  eventData: event.data,
                },
                '[SSETransformer] Error processing token chunk',
              );
            }
          } else if (event.event === 'on_chain_stream' && event.metadata?.langgraph_node) {
            // Track the current node
            lastNodeName = event.metadata.langgraph_node;

            // Send workflow step event
            const stepEvent = `event: workflow_step\ndata: ${JSON.stringify({
              step: lastNodeName,
            })}\n\n`;
            controller.enqueue(encoder.encode(stepEvent));

            logger.debug(
              {
                node: lastNodeName,
              },
              '[SSETransformer] Processing node event',
            );

            // If this is a state update that includes docs, extract them
            if (
              event.data?.state?.docs &&
              Array.isArray(event.data.state.docs) &&
              event.data.state.docs.length > 0
            ) {
              const docs = event.data.state.docs;
              logger.info(
                {
                  docsCount: docs.length,
                },
                '[SSETransformer] Found sources',
              );

              try {
                // Extract source metadata
                sources = docs.map((doc: any) => ({
                  id: doc.id,
                  title: doc.title,
                  source: doc.metadata.source,
                  url: doc.metadata.url,
                  relevanceScore: doc.metadata.relevanceScore,
                }));

                // Send sources event
                const sourcesEvent = `event: sources\ndata: ${JSON.stringify(sources)}\n\n`;
                controller.enqueue(encoder.encode(sourcesEvent));
              } catch (e) {
                logger.warn(
                  {
                    error: e,
                  },
                  '[SSETransformer] Error processing sources',
                );
              }
            }
          } else if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
            // This is the final event for the entire graph
            finalExecutionTime = performance.now() - startTime;
            logger.info(
              {
                executionTimeMs: Math.round(finalExecutionTime),
              },
              '[SSETransformer] Graph execution completed',
            );

            // Send final event
            const finalEvent = `event: final\ndata: ${JSON.stringify({
              executionTimeMs: Math.round(finalExecutionTime),
            })}\n\n`;
            controller.enqueue(encoder.encode(finalEvent));
          }
        }

        logger.info(
          {
            eventCount: stateCount,
            finalTextLength: accumulatedText.length,
            sourcesCount: sources.length,
            executionTimeMs: Math.round(finalExecutionTime),
          },
          '[SSETransformer] Stream iteration complete, sending end event',
        );

        // As a final fallback, ensure we've sent the complete text
        if (accumulatedText.length > 0) {
          // Check if accumulated text appears to be thinking content
          const isThinking = accumulatedText.includes('<thinking>');

          // Send the final text one more time to ensure client has complete response
          if (isThinking) {
            const finalThinkingEvent = `event: thinking\ndata: ${JSON.stringify({
              thinking: processThinkingContent(accumulatedText),
            })}\n\n`;
            controller.enqueue(encoder.encode(finalThinkingEvent));
          } else {
            const finalTextEvent = `event: text\ndata: ${JSON.stringify({
              text: accumulatedText,
            })}\n\n`;
            controller.enqueue(encoder.encode(finalTextEvent));
          }
        }

        // Send end event
        const endEvent = `event: end\ndata: {}\n\n`;
        controller.enqueue(encoder.encode(endEvent));
        controller.close();
      } catch (error) {
        logError(error, '[SSETransformer] Error streaming SSE events');
        const errorMessage = error instanceof Error ? error.message : String(error);

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
