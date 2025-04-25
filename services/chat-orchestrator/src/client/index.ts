/**
 * Chat Orchestrator Client
 *
 * This file exports the client interface for the Chat Orchestrator service.
 */

import { 
  ChatOrchestratorClient, 
  ChatOrchestratorRequest, 
  ChatOrchestratorResponse,
  createChatOrchestratorClient
} from './client';

export {
  ChatOrchestratorClient,
  ChatOrchestratorRequest,
  ChatOrchestratorResponse,
  createChatOrchestratorClient
};

/**
 * Chat Orchestrator Binding Interface
 * 
 * Defines the contract for the Cloudflare Worker binding to the Chat Orchestrator service
 */
export interface ChatOrchestratorBinding {
  // Chat methods
  generateChatResponse(request: ChatOrchestratorRequest): Promise<Response>;
  resumeChatSession(request: { runId: string; newMessage?: any }): Promise<Response>;

  // Admin methods
  getCheckpointStats(): Promise<any>;
  cleanupCheckpoints(): Promise<{ deletedCount: number }>;
  getDataRetentionStats(): Promise<any>;
  cleanupExpiredData(): Promise<any>;
  deleteUserData(userId: string): Promise<{ deletedCount: number }>;
  recordConsent(userId: string, dataCategory: string, request: { durationDays: number }): Promise<{ success: boolean }>;
}
