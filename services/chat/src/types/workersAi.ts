/**
 * Type definitions for Cloudflare Workers AI
 * These types match the actual API structure of the Workers AI binding
 */

export interface WorkersAiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface WorkersAiRunOptions {
  messages: WorkersAiMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface WorkersAiResponse {
  response: string;
}

export interface WorkersAi {
  run: (
    modelId: string, 
    options: WorkersAiRunOptions
  ) => Promise<WorkersAiResponse | ReadableStream>;
}