/**
 * Chat Orchestrator Service
 *
 * This is the main entry point for the Chat Orchestrator service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing using Hono for routing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { getLogger, logError } from '@dome/logging';
import { createServices } from './services';
import { createControllers } from './controllers';
import { ChatBinding } from './client';
import { withErrorHandling } from './utils/errorHandler';
import { handleWebSocketChat } from './controllers/chatController';

export * from './client';

/**
 * Chat Orchestrator service main class
 */
export default class Chat
  extends WorkerEntrypoint<Env>
  implements ChatBinding
{
  private services;
  private controllers;
  private app: Hono;
  private logger = getLogger().child({ component: 'Chat' });

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);

    // Initialize services and controllers
    this.services = createServices(env);
    this.controllers = createControllers(env, this.services);
    
    // Create Hono app instance
    this.app = new Hono();
    
    // Setup routes
    this.setupRoutes(env);

    this.logger.info('Chat Orchestrator service initialized');
  }
  
  /**
   * Setup all HTTP and WebSocket routes
   */
  private setupRoutes(env: Env) {
    // WebSocket route
    this.app.get('/ws', upgradeWebSocket((c) => {
      const logger = this.logger.child({ component: 'WebSocketHandler' });
      logger.info('WebSocket connection upgrade requested');
      
      return {
        onMessage: (event, ws) => {
          try {
            // Parse the message as JSON
            const message = JSON.parse(event.data as string);
            logger.debug({ messageType: message.type }, 'Received WebSocket message');
            
            // Handle the message based on type
            if (message.type === 'new_chat' || message.type === 'resume_chat') {
              // Handle the chat request - using the new handler
              handleWebSocketChat(
                env,
                this.services,
                ws as unknown as WebSocket, // Cast to WebSocket interface
                message
              );
            } else {
              logger.warn({ messageType: message.type }, 'Unknown WebSocket message type');
              ws.send(JSON.stringify({
                type: 'error',
                data: { message: `Unknown message type: ${message.type}` }
              }));
            }
          } catch (error) {
            logError(error, 'Error handling WebSocket message');
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: error instanceof Error ? error.message : String(error) }
            }));
          }
        },
        onClose: () => {
          logger.info('WebSocket connection closed');
        },
        onError: (err) => {
          logError(err, 'WebSocket connection error');
        }
      };
    }));
    
    // HTTP routes
    this.app.post('/chat', async (c) => {
      const requestData = await c.req.json();
      return await this.controllers.chat.generateChatResponse(requestData);
    });
    
    this.app.post('/chat/message', async (c) => {
      const requestData = await c.req.json();
      return await this.controllers.chat.generateChatMessage(requestData);
    });
    
    this.app.post('/chat/resume', async (c) => {
      const requestData = await c.req.json();
      return await this.controllers.chat.resumeChatSession(requestData);
    });
    
    this.app.get('/admin/checkpoints', async (c) => {
      return c.json(await this.controllers.admin.getCheckpointStats());
    });
    
    this.app.post('/admin/checkpoints/cleanup', async (c) => {
      return c.json(await this.controllers.admin.cleanupCheckpoints());
    });
    
    // Catch-all for 404
    this.app.notFound((c) => {
      return c.json({ error: 'Not Found' }, 404);
    });
  }

  /**
   * Generate a chat response with streaming
   * @param request Chat request
   * @returns Streaming response
   */
  /**
   * Main fetch handler for the worker
   * This handles HTTP and WebSocket requests
   */
  /**
   * Main fetch handler for the worker
   * This delegates to the Hono app
   */
  async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const ctx = this.ctx;
    try {
      return this.app.fetch(request, env, ctx);
    } catch (error) {
      logError(error, 'Error handling HTTP request');
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  /**
   * Generate a chat response with streaming
   * @param request Chat request
   * @returns Streaming response
   */
  async generateChatResponse(request: any): Promise<Response> {
    try {
      this.logger.info(
        {
          operation: 'generateChatResponse',
          userId: request?.userId,
        },
        'RPC call received',
      );

      // Now this just delegates to the controller
      return await this.controllers.chat.generateChatResponse(request);
    } catch (error) {
      this.logger.error(
        {
          operation: 'generateChatResponse',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Resume a chat session
   * @param request Resume chat request
   * @returns Streaming response
   */
  async resumeChatSession(request: any): Promise<Response> {
    try {
      this.logger.info(
        {
          operation: 'resumeChatSession',
          runId: request?.runId,
        },
        'RPC call received',
      );

      return await this.controllers.chat.resumeChatSession(request);
    } catch (error) {
      this.logger.error(
        {
          operation: 'resumeChatSession',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Generate a chat message (non-streaming)
   * @param request Chat request
   * @returns Complete response with aggregated output
   */
  async generateChatMessage(request: any): Promise<Response> {
    try {
      this.logger.info(
        {
          operation: 'generateChatMessage',
          userId: request?.userId,
        },
        'RPC call received',
      );

      // Delegate to the controller
      return await this.controllers.chat.generateChatMessage(request);
    } catch (error) {
      this.logger.error(
        {
          operation: 'generateChatMessage',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    try {
      this.logger.info(
        {
          operation: 'getCheckpointStats',
        },
        'RPC call received',
      );

      return await this.controllers.admin.getCheckpointStats();
    } catch (error) {
      this.logger.error(
        {
          operation: 'getCheckpointStats',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    try {
      this.logger.info(
        {
          operation: 'cleanupCheckpoints',
        },
        'RPC call received',
      );

      return await this.controllers.admin.cleanupCheckpoints();
    } catch (error) {
      this.logger.error(
        {
          operation: 'cleanupCheckpoints',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    try {
      this.logger.info(
        {
          operation: 'getDataRetentionStats',
        },
        'RPC call received',
      );

      return await this.controllers.admin.getDataRetentionStats();
    } catch (error) {
      this.logger.error(
        {
          operation: 'getDataRetentionStats',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    try {
      this.logger.info(
        {
          operation: 'cleanupExpiredData',
        },
        'RPC call received',
      );

      return await this.controllers.admin.cleanupExpiredData();
    } catch (error) {
      this.logger.error(
        {
          operation: 'cleanupExpiredData',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    try {
      this.logger.info(
        {
          operation: 'deleteUserData',
          userId,
        },
        'RPC call received',
      );

      return await this.controllers.admin.deleteUserData(userId);
    } catch (error) {
      this.logger.error(
        {
          operation: 'deleteUserData',
          userId,
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Record user consent
   * @param userId User ID
   * @param dataCategory Data category
   * @param request Consent request
   * @returns Success result
   */
  async recordConsent(
    userId: string,
    dataCategory: string,
    request: { durationDays: number },
  ): Promise<{ success: boolean }> {
    try {
      this.logger.info(
        {
          operation: 'recordConsent',
          userId,
          dataCategory,
        },
        'RPC call received',
      );

      return await this.controllers.admin.recordConsent(userId, dataCategory, request);
    } catch (error) {
      this.logger.error(
        {
          operation: 'recordConsent',
          userId,
          dataCategory,
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }
}
