import fs from 'fs';
import path from 'path';
import os from 'os';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

class ChatSessionManager {
  private sessionFile: string;
  private messages: ChatMessage[] = [];
  private readonly MAX_HISTORY = 20; // Limit history to prevent excessive token usage

  constructor() {
    const domeDir = path.join(os.homedir(), '.dome');
    if (!fs.existsSync(domeDir)) {
      fs.mkdirSync(domeDir, { recursive: true });
    }
    this.sessionFile = path.join(domeDir, 'chat_session.json');
    this.loadSession();
  }

  private loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = fs.readFileSync(this.sessionFile, 'utf8');
        this.messages = JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load chat session:', error);
      this.messages = [];
    }
  }

  private saveSession() {
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify(this.messages), 'utf8');
    } catch (error) {
      console.error('Failed to save chat session:', error);
    }
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  addUserMessage(content: string): void {
    this.messages.push({
      role: 'user',
      content,
      timestamp: Date.now(),
    });
    
    // Trim history if needed
    if (this.messages.length > this.MAX_HISTORY) {
      this.messages = this.messages.slice(-this.MAX_HISTORY);
    }
    
    this.saveSession();
  }

  addAssistantMessage(content: string): void {
    this.messages.push({
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
    
    // Trim history if needed
    if (this.messages.length > this.MAX_HISTORY) {
      this.messages = this.messages.slice(-this.MAX_HISTORY);
    }
    
    this.saveSession();
  }

  clearSession(): void {
    this.messages = [];
    this.saveSession();
  }
}

// Singleton instance
let sessionManager: ChatSessionManager;

export const getChatSession = (): ChatSessionManager => {
  if (!sessionManager) {
    sessionManager = new ChatSessionManager();
  }
  return sessionManager;
};