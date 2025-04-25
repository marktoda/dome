import { ChatOrchestratorClient, ChatOrchestratorRequest, ChatOrchestratorResponse } from './client';

export {
  ChatOrchestratorClient,
  ChatOrchestratorRequest,
  ChatOrchestratorResponse
};

// Define the binding interface for the chat orchestrator
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
