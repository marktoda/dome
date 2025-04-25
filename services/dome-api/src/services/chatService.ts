import { getLogger } from '@dome/logging';
import { z } from 'zod';
import { ChatOrchestratorClient } from '../../../chat-orchestrator/src/client';

/**
 * Chat message schema
 */
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.number().optional(),
});

/**
 * Chat request schema
 */
const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema),
  userId: z.string(),
  stream: z.boolean().optional().default(false),
  enhanceWithContext: z.boolean().optional().default(true),
  maxContextItems: z.number().optional().default(10),
  includeSourceInfo: z.boolean().optional().default(true),
  maxTokens: z.number().optional().default(4000),
  temperature: z.number().optional().default(0.7),
});

/**
 * Chat service for handling chat requests
 */
export class ChatService {
  private logger = getLogger().child({ service: 'ChatService' });
  private chatOrchestratorClient: ChatOrchestratorClient;

  /**
   * Create a new chat service
   * @param env Environment bindings
   */
  constructor(private env: Bindings) {
    this.chatOrchestratorClient = new ChatOrchestratorClient(env);
  }

  /**
   * Generate a chat response
   * @param env Environment bindings
   * @param request Chat request
   * @returns Generated response
   */
  async generateResponse(env: Bindings, request: any): Promise<string> {
    try {
      // Validate the request
      const validatedRequest = chatRequestSchema.parse(request);
      
      // Prepare the request for the chat orchestrator
      const orchestratorRequest = {
        initialState: {
          userId: validatedRequest.userId,
          messages: validatedRequest.messages,
          enhanceWithContext: validatedRequest.enhanceWithContext,
          maxContextItems: validatedRequest.maxContextItems,
          includeSourceInfo: validatedRequest.includeSourceInfo,
          maxTokens: validatedRequest.maxTokens,
          temperature: validatedRequest.temperature,
        },
      };
      
      // Call the chat orchestrator via RPC
      const result = await this.chatOrchestratorClient.generateResponse(orchestratorRequest);
      
      return result.response;
    } catch (error) {
      this.logger.error({ err: error }, 'Error generating chat response');
      throw error;
    }
  }

  /**
   * Stream a chat response
   * @param env Environment bindings
   * @param request Chat request
   * @returns Response with streaming content
   */
  async streamResponse(env: Bindings, request: any): Promise<Response> {
    try {
      // Validate the request
      const validatedRequest = chatRequestSchema.parse(request);
      
      // Prepare the request for the chat orchestrator
      const orchestratorRequest = {
        initialState: {
          userId: validatedRequest.userId,
          messages: validatedRequest.messages,
          enhanceWithContext: validatedRequest.enhanceWithContext,
          maxContextItems: validatedRequest.maxContextItems,
          includeSourceInfo: validatedRequest.includeSourceInfo,
          maxTokens: validatedRequest.maxTokens,
          temperature: validatedRequest.temperature,
        },
      };
      
      // Call the chat orchestrator via RPC
      return await this.chatOrchestratorClient.streamResponse(orchestratorRequest);
    } catch (error) {
      this.logger.error({ err: error }, 'Error streaming chat response');
      throw error;
    }
  }
}
