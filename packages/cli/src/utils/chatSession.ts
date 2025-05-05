import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

export type ChatSession = {
  id: string;
  name: string;
  lastUpdated: number;
  messages: ChatMessage[];
};

/**
 * Manages chat sessions for the CLI, providing persistence and isolation
 * between separate chat conversations.
 */
class ChatSessionManager {
  private sessionsDir: string;
  private activeSessionId: string = '';
  private sessions: Map<string, ChatSession> = new Map();
  private readonly MAX_HISTORY = 20; // Limit history to prevent excessive token usage
  private readonly SESSION_FILE = 'active_session.id';

  constructor() {
    // Set up storage directory
    const domeDir = path.join(os.homedir(), '.dome');
    if (!fs.existsSync(domeDir)) {
      fs.mkdirSync(domeDir, { recursive: true });
    }
    
    this.sessionsDir = path.join(domeDir, 'chat_sessions');
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
    
    // Load active session ID
    const sessionIdFile = path.join(domeDir, this.SESSION_FILE);
    try {
      if (fs.existsSync(sessionIdFile)) {
        this.activeSessionId = fs.readFileSync(sessionIdFile, 'utf8').trim();
      }
    } catch (error) {
      // If we can't read the session ID file, create a new session
      this.activeSessionId = '';
    }
    
    // If there's no active session or if it doesn't exist, create a new one
    if (!this.activeSessionId || !this.sessionExists(this.activeSessionId)) {
      this.createNewSession();
    } else {
      this.loadSession(this.activeSessionId);
    }
  }
  
  /**
   * Check if a session exists
   */
  private sessionExists(sessionId: string): boolean {
    const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
    return fs.existsSync(sessionFile);
  }
  
  /**
   * Load a specific session by ID
   */
  private loadSession(sessionId: string): void {
    try {
      const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(sessionFile)) {
        const data = fs.readFileSync(sessionFile, 'utf8');
        const session = JSON.parse(data) as ChatSession;
        this.sessions.set(sessionId, session);
        this.activeSessionId = sessionId;
        this.saveActiveSessionId();
      } else {
        this.createNewSession();
      }
    } catch (error) {
      console.error(`Failed to load chat session ${sessionId}:`, error);
      this.createNewSession();
    }
  }
  
  /**
   * Create a new session
   */
  private createNewSession(): void {
    const sessionId = crypto.randomUUID();
    const session: ChatSession = {
      id: sessionId,
      name: `Chat Session ${new Date().toLocaleString()}`,
      lastUpdated: Date.now(),
      messages: []
    };
    
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;
    this.saveSession(sessionId);
    this.saveActiveSessionId();
  }
  
  /**
   * Save active session ID to file
   */
  private saveActiveSessionId(): void {
    try {
      const sessionIdFile = path.join(os.homedir(), '.dome', this.SESSION_FILE);
      fs.writeFileSync(sessionIdFile, this.activeSessionId, 'utf8');
    } catch (error) {
      console.error('Failed to save active session ID:', error);
    }
  }
  
  /**
   * Save a specific session by ID
   */
  private saveSession(sessionId: string): void {
    try {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.lastUpdated = Date.now();
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf8');
      }
    } catch (error) {
      console.error(`Failed to save chat session ${sessionId}:`, error);
    }
  }
  
  /**
   * Get list of available sessions
   */
  listSessions(): ChatSession[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessions: ChatSession[] = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const sessionId = file.replace('.json', '');
            if (!this.sessions.has(sessionId)) {
              const data = fs.readFileSync(path.join(this.sessionsDir, file), 'utf8');
              const session = JSON.parse(data) as ChatSession;
              this.sessions.set(sessionId, session);
            }
            sessions.push(this.sessions.get(sessionId)!);
          } catch (e) {
            // Skip invalid session files
          }
        }
      }
      
      // Sort by last updated (newest first)
      return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
    } catch (error) {
      console.error('Failed to list chat sessions:', error);
      return [];
    }
  }
  
  /**
   * Switch to a different session
   */
  switchSession(sessionId: string): boolean {
    if (this.sessionExists(sessionId)) {
      this.loadSession(sessionId);
      return true;
    }
    return false;
  }
  
  /**
   * Get messages from current session
   */
  getMessages(): ChatMessage[] {
    const session = this.sessions.get(this.activeSessionId);
    return session ? [...session.messages] : [];
  }
  
  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.activeSessionId;
  }
  
  /**
   * Get current session name
   */
  getSessionName(): string {
    const session = this.sessions.get(this.activeSessionId);
    return session?.name || 'Unnamed Session';
  }
  
  /**
   * Set name for current session
   */
  setSessionName(name: string): void {
    const session = this.sessions.get(this.activeSessionId);
    if (session) {
      session.name = name;
      this.saveSession(this.activeSessionId);
    }
  }

  /**
   * Add user message to current session
   */
  addUserMessage(content: string): void {
    const session = this.sessions.get(this.activeSessionId);
    if (session) {
      session.messages.push({
        role: 'user',
        content,
        timestamp: Date.now(),
      });
      
      // Trim history if needed
      if (session.messages.length > this.MAX_HISTORY) {
        session.messages = session.messages.slice(-this.MAX_HISTORY);
      }
      
      this.saveSession(this.activeSessionId);
    }
  }

  /**
   * Add assistant message to current session
   */
  addAssistantMessage(content: string): void {
    const session = this.sessions.get(this.activeSessionId);
    if (session) {
      session.messages.push({
        role: 'assistant',
        content,
        timestamp: Date.now(),
      });
      
      // Trim history if needed
      if (session.messages.length > this.MAX_HISTORY) {
        session.messages = session.messages.slice(-this.MAX_HISTORY);
      }
      
      this.saveSession(this.activeSessionId);
    }
  }

  /**
   * Clear current session
   */
  clearSession(): void {
    const session = this.sessions.get(this.activeSessionId);
    if (session) {
      session.messages = [];
      this.saveSession(this.activeSessionId);
    }
  }
  
  /**
   * Delete a session by ID
   */
  deleteSession(sessionId: string): boolean {
    try {
      const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        this.sessions.delete(sessionId);
        
        // If we deleted the active session, create a new one
        if (sessionId === this.activeSessionId) {
          this.createNewSession();
        }
        
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Failed to delete chat session ${sessionId}:`, error);
      return false;
    }
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