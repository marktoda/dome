/**
 * Chat Orchestrator Client
 *
 * This file exports the client interface for the Chat Orchestrator service.
 */

import {
  ChatClient,
  ChatOrchestratorResponse,
  createChatClient,
} from './client';
import { ChatRequest } from '../types';

export { ChatClient, ChatOrchestratorResponse, createChatClient };

export * from '../types';


/**
 * Chat Orchestrator Binding Interface
 *
 * Defines the contract for the Cloudflare Worker binding to the Chat Orchestrator service
 */
export interface ChatOrchestratorBinding {
  // Chat methods
  generateChatResponse(request: ChatRequest): Promise<Response>;
  resumeChatSession(request: { runId: string; newMessage?: any }): Promise<Response>;

  // Admin methods
  getCheckpointStats(): Promise<any>;
  cleanupCheckpoints(): Promise<{ deletedCount: number }>;
  getDataRetentionStats(): Promise<any>;
  cleanupExpiredData(): Promise<any>;
  deleteUserData(userId: string): Promise<{ deletedCount: number }>;
  recordConsent(
    userId: string,
    dataCategory: string,
    request: { durationDays: number },
  ): Promise<{ success: boolean }>;
}
