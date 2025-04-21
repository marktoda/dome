import { Context } from 'hono';
import { z } from 'zod';
import { Bindings } from '../types';
import { ServiceError, UnauthorizedError, ValidationError } from '@dome/common';
import { chatService, ChatMessage } from '../services/chatService';
import { getLogger } from '@dome/logging';

/**
 * Chat message schema
 */
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1, 'Message content is required'),
});

/**
 * Chat request schema
 */
const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, 'At least one message is required'),
  stream: z.boolean().optional().default(false),
  enhanceWithContext: z.boolean().optional().default(true),
  maxContextItems: z.number().int().positive().optional().default(5),
  includeSourceInfo: z.boolean().optional().default(true),
  suggestAddCommand: z.boolean().optional().default(true),
});

/**
 * Controller for chat operations
 */
export class ChatController {
  /**
   * Process a chat request with RAG enhancement
   * @param c Hono context
   * @returns Response
   */
  async chat(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    getLogger().info(
      {
        path: c.req.path,
        method: c.req.method,
      },
      'Chat processing started',
    );

    try {
      // Validate request body
      const body = await c.req.json();
      getLogger().debug({ requestBody: body }, 'Received chat request data');
      const validatedData = chatRequestSchema.parse(body);

      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId }, 'User ID extracted for chat processing');

      if (!userId) {
        getLogger().warn({ path: c.req.path }, 'Missing user ID in chat request');
        throw new UnauthorizedError(
          'User ID is required. Provide it via x-user-id header or userId query parameter',
        );
      }

      // Get the last user message
      const lastUserMessage = [...validatedData.messages]
        .reverse()
        .find(msg => msg.role === 'user');

      if (!lastUserMessage) {
        getLogger().warn({ userId }, 'No user message found in chat request');
        throw new ValidationError('At least one user message is required');
      }

      // Prepare chat options
      getLogger().debug(
        {
          userId,
          messageCount: validatedData.messages.length,
          lastUserMessage:
            lastUserMessage.content.substring(0, 100) +
            (lastUserMessage.content.length > 100 ? '...' : ''),
          enhanceWithContext: validatedData.enhanceWithContext,
          streaming: validatedData.stream,
        },
        'Preparing chat options',
      );

      const chatOptions = {
        messages: validatedData.messages as ChatMessage[],
        userId,
        enhanceWithContext: validatedData.enhanceWithContext,
        maxContextItems: validatedData.maxContextItems,
        includeSourceInfo: validatedData.includeSourceInfo,
        suggestAddCommand: validatedData.suggestAddCommand,
      };

      // If streaming is requested, use streaming response
      if (validatedData.stream) {
        getLogger().info({ userId }, 'Starting streaming chat response');
        const stream = await chatService.streamResponse(c.env, chatOptions);

        getLogger().info({ userId }, 'Streaming response initialized');
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked',
          },
        });
      }

      // Otherwise, use regular response
      getLogger().info({ userId }, 'Generating chat response');

      try {
        const response = await chatService.generateResponse(c.env, chatOptions);

        // Ensure we have a valid response
        if (response === undefined) {
          getLogger().warn({ userId }, 'Chat response was undefined');
          return c.json({
            success: false,
            error: {
              code: 'CHAT_ERROR',
              message: 'Failed to generate chat response',
            },
            response:
              "I'm sorry, but I couldn't generate a response at this time. Please try again later.",
          });
        }

        getLogger().info(
          {
            userId,
            responseLength:
              typeof response === 'string' ? response.length : JSON.stringify(response).length,
          },
          'Chat response successfully generated',
        );
        return c.json({
          success: true,
          response,
        });
      } catch (chatError) {
        getLogger().error({ err: chatError, userId }, 'Error generating chat response');

        // Return a graceful error response instead of throwing
        return c.json(
          {
            success: false,
            error: {
              code: 'CHAT_ERROR',
              message: 'Failed to generate chat response',
            },
            response:
              "I apologize, but I'm experiencing technical difficulties. Please try again later.",
          },
          200,
        ); // Return 200 status to allow the client to display the error message
      }
    } catch (error) {
      getLogger().error(
        {
          err: error,
          path: c.req.path,
          userId: c.req.header('x-user-id') || c.req.query('userId'),
        },
        'Error in chat controller',
      );

      // Let the middleware handle the error
      throw error;
    }
  }
}

// Export singleton instance
export const chatController = new ChatController();
