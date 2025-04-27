/**
 * Chat Orchestrator Client
 *
 * This file exports the client interface for the Chat Orchestrator service.
 */

import {
  ChatClient,
  ChatResponse,
  ChatServerResponse,
  ResponseMetadata,
  ServerResponseMetadata,
  createChatClient
} from './client';
import {
  WebSocketClient,
  WebSocketCallbacks,
  WebSocketOptions,
  createWebSocketClient
} from './websocketClient';
import { ChatRequest } from '../types';

export {
  ChatClient,
  ChatResponse,
  ChatServerResponse,
  ResponseMetadata,
  ServerResponseMetadata,
  createChatClient,
  WebSocketClient,
  WebSocketCallbacks,
  WebSocketOptions,
  createWebSocketClient
};

export * from '../types';

/**
 * Chat Orchestrator Binding Interface
 *
 * Defines the contract for the Cloudflare Worker binding to the Chat Orchestrator service
 */
export interface ChatBinding {
  // Chat methods
  generateChatResponse(request: ChatRequest): Promise<Response>;
  generateChatMessage(request: ChatRequest): Promise<Response>;
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
