import { getLogger, logError } from '@dome/common';
import { AgentState } from '../types';

/**
 * WebSocket message types for different event categories
 */
export enum MessageType {
  TEXT = 'text',
  SOURCES = 'sources',
  WORKFLOW_STEP = 'workflow_step',
  FINAL = 'final',
  ERROR = 'error',
  END = 'end'
}

/**
 * WebSocket message interface
 */
export interface WebSocketMessage {
  type: MessageType;
  data: Record<string, any>;
}

/**
 * Transform LangGraph output to WebSocket messages
 * @param stream AsyncIterable from LangGraph execution
 * @param startTime Start time for performance measurement
 * @param webSocket WebSocket connection
 * @returns Promise that resolves when stream processing is complete
 */
export async function transformToWebSocket(
  stream: any, 
  startTime: number,
  webSocket: WebSocket
): Promise<void> {
  const logger = getLogger().child({ component: 'WebSocketTransformer' });

  // Store accumulated content
  let accumulatedText = '';
  let sources: any[] = [];
  let stateCount = 0;
  let finalExecutionTime = 0;
  let lastNodeName = '';

  try {
    logger.info('Starting WebSocket transformation with message streaming mode');
    
    // Process each event from the LangGraph stream
    for await (const event of stream) {
      stateCount++;
      
      // Log information about the event for debugging
      logger.debug({
        eventNumber: stateCount,
        eventType: event.event,
        eventName: event.name,
        metadata: event.metadata,
        hasData: !!event.data,
        dataKeys: event.data ? Object.keys(event.data) : []
      }, '[WebSocketTransformer] Processing event');

      // Handle different event types
      if (event.event === 'on_chat_model_stream') {
        // This is a token-level streaming event from the LLM
        try {
          // Extract the token chunk
          const chunk = event.data?.chunk;
          if (chunk && chunk.content) {
            // Add this chunk to our accumulated text
            accumulatedText += chunk.content;
            
            // Send the updated text to the client
            logger.debug({
              chunkLength: chunk.content.length,
              chunkContent: chunk.content,
              totalLength: accumulatedText.length
            }, '[WebSocketTransformer] Sending token chunk');
            
            // Send as a text message
            const message: WebSocketMessage = {
              type: MessageType.TEXT,
              data: { text: accumulatedText }
            };
            
            webSocket.send(JSON.stringify(message));
          }
        } catch (e) {
          logger.warn({
            error: e,
            eventData: event.data
          }, '[WebSocketTransformer] Error processing token chunk');
        }
      } else if (event.event === 'on_chain_stream' && event.metadata?.langgraph_node) {
        // Track the current node
        lastNodeName = event.metadata.langgraph_node;
        
        // Send workflow step message
        const stepMessage: WebSocketMessage = {
          type: MessageType.WORKFLOW_STEP,
          data: { step: lastNodeName }
        };
        
        webSocket.send(JSON.stringify(stepMessage));
        
        logger.debug({
          node: lastNodeName
        }, '[WebSocketTransformer] Processing node event');
        
        // If this is a state update that includes docs, extract them
        if (event.data?.state?.docs && Array.isArray(event.data.state.docs) && event.data.state.docs.length > 0) {
          const docs = event.data.state.docs;
          logger.info({
            docsCount: docs.length
          }, '[WebSocketTransformer] Found sources');
          
          try {
            // Extract source metadata
            sources = docs.map((doc: any) => ({
              id: doc.id,
              title: doc.title,
              source: doc.metadata.source,
              url: doc.metadata.url,
              relevanceScore: doc.metadata.relevanceScore,
            }));
            
            // Send sources message
            const sourcesMessage: WebSocketMessage = {
              type: MessageType.SOURCES,
              data: { sources }
            };
            
            webSocket.send(JSON.stringify(sourcesMessage));
          } catch (e) {
            logger.warn({
              error: e
            }, '[WebSocketTransformer] Error processing sources');
          }
        }
      } else if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
        // This is the final event for the entire graph
        finalExecutionTime = performance.now() - startTime;
        logger.info({
          executionTimeMs: Math.round(finalExecutionTime)
        }, '[WebSocketTransformer] Graph execution completed');
        
        // Send final message
        const finalMessage: WebSocketMessage = {
          type: MessageType.FINAL,
          data: { executionTimeMs: Math.round(finalExecutionTime) }
        };
        
        webSocket.send(JSON.stringify(finalMessage));
      }
    }

    logger.info({
      eventCount: stateCount,
      finalTextLength: accumulatedText.length,
      sourcesCount: sources.length,
      executionTimeMs: Math.round(finalExecutionTime)
    }, '[WebSocketTransformer] Stream iteration complete, sending end message');
    
    // As a final fallback, ensure we've sent the complete text
    if (accumulatedText.length > 0) {
      // Send the final text one more time to ensure client has complete response
      const finalTextMessage: WebSocketMessage = {
        type: MessageType.TEXT,
        data: { text: accumulatedText }
      };
      
      webSocket.send(JSON.stringify(finalTextMessage));
    }
    
    // Send end message
    const endMessage: WebSocketMessage = {
      type: MessageType.END,
      data: {}
    };
    
    webSocket.send(JSON.stringify(endMessage));
  } catch (error) {
    logError(error, '[WebSocketTransformer] Error streaming WebSocket messages');
    
    // Send error message
    const errorMessage: WebSocketMessage = {
      type: MessageType.ERROR,
      data: { message: error instanceof Error ? error.message : String(error) }
    };
    
    webSocket.send(JSON.stringify(errorMessage));
  }
}

/**
 * Send error message through WebSocket
 * @param webSocket WebSocket connection
 * @param error Error object
 */
export function sendErrorMessage(webSocket: WebSocket, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  const message: WebSocketMessage = {
    type: MessageType.ERROR,
    data: { message: errorMessage }
  };
  
  webSocket.send(JSON.stringify(message));
}
