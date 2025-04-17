import { Context } from 'hono';
import { z } from 'zod';
import { Bindings } from '../types';
import { ServiceError } from '@dome/common';
import { chatService, ChatMessage } from '../services/chatService';

/**
 * Chat message schema
 */
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1, 'Message content is required')
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
  suggestAddCommand: z.boolean().optional().default(true)
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
    try {
      // Validate request body
      const body = await c.req.json();
      const validatedData = chatRequestSchema.parse(body);
      
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }

      // Get the last user message
      const lastUserMessage = [...validatedData.messages].reverse()
        .find(msg => msg.role === 'user');
      
      if (!lastUserMessage) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'At least one user message is required'
          }
        }, 400);
      }

      // Prepare chat options
      const chatOptions = {
        messages: validatedData.messages as ChatMessage[],
        userId,
        enhanceWithContext: validatedData.enhanceWithContext,
        maxContextItems: validatedData.maxContextItems,
        includeSourceInfo: validatedData.includeSourceInfo,
        suggestAddCommand: validatedData.suggestAddCommand
      };

      // If streaming is requested, use streaming response
      if (validatedData.stream) {
        const stream = await chatService.streamResponse(c.env, chatOptions);
        
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked'
          }
        });
      }

      // Otherwise, use regular response
      const response = await chatService.generateResponse(c.env, chatOptions);

      return c.json({
        success: true,
        response
      });
    } catch (error) {
      console.error('Error in chat controller:', error);
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid chat request',
            details: error.errors
          }
        }, 400);
      }
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred during chat processing'
        }
      }, 500);
    }
  }
}

// Export singleton instance
export const chatController = new ChatController();