// This file requires @types/node to be installed for Buffer and crypto types
// Run: npm install --save-dev @types/node
import { redisService } from './redis';
import { SESSION } from '../config';
import { logger } from '../utils/logger';
import { generateRandomId, generateSecretKey } from '../utils/security';
import { RedisError, SessionError } from '../utils/errors';
// Node.js built-in modules
import * as crypto from 'crypto';

/**
 * Interface for session data
 */
export interface SessionData {
  id: string;
  userId?: string;
  phoneNumber?: string;
  authKey?: string;
  dcId?: number;
  serverAddress?: string;
  port?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  isActive: boolean;
  metadata?: Record<string, any>;
  lastUsed?: number;
}

/**
 * Interface for user information
 */
export interface UserInfo {
  id: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

/**
 * Interface for session metadata
 */
export interface SessionMetadata {
  deviceInfo?: {
    name?: string;
    platform?: string;
    version?: string;
    ip?: string;
  };
  lastActivity?: {
    action?: string;
    timestamp?: number;
  };
  permissions?: string[];
  tags?: string[];
}

/**
 * Session store for managing Telegram sessions
 */
export class SessionStore {
  private readonly sessionKeyPrefix = 'session:';
  private readonly userSessionsKeyPrefix = 'user:sessions:';
  private readonly ttlSeconds: number;
  private readonly encryptionKey: Buffer;

  constructor(ttlSeconds = SESSION.TTL_SECONDS) {
    this.ttlSeconds = ttlSeconds;
    
    // Initialize encryption key (in production, this should be loaded from a secure source)
    const encryptionKeyHex = process.env.SESSION_ENCRYPTION_KEY || generateSecretKey(32);
    this.encryptionKey = Buffer.from(encryptionKeyHex, 'hex');
  }

  /**
   * Create a new session
   */
  async createSession(data: Partial<SessionData> = {}): Promise<SessionData> {
    const now = Date.now();
    const sessionId = data.id || generateRandomId();
    
    const session: SessionData = {
      id: sessionId,
      userId: data.userId,
      phoneNumber: data.phoneNumber,
      authKey: data.authKey,
      dcId: data.dcId,
      serverAddress: data.serverAddress,
      port: data.port,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
      isActive: true,
      metadata: data.metadata || {},
    };

    await this.saveSession(session);
    logger.info(`Created session: ${sessionId}`);
    
    return session;
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      const key = this.getSessionKey(sessionId);
      const data = await redisService.getValue(key);
      
      if (!data) {
        return null;
      }
      
      // Parse and decrypt the session data
      const encryptedSession = JSON.parse(data);
      return this.decryptSessionData(encryptedSession);
    } catch (error) {
      logger.error(`Error getting session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Save a session
   */
  async saveSession(session: SessionData): Promise<void> {
    try {
      // Encrypt sensitive data
      const encryptedSession = this.encryptSessionData(session);
      
      // Save the session
      const key = this.getSessionKey(session.id);
      const data = JSON.stringify(encryptedSession);
      
      // Calculate TTL based on expiresAt
      const now = Date.now();
      const ttl = Math.max(Math.floor((session.expiresAt - now) / 1000), 1);
      
      await redisService.setWithExpiry(key, data, ttl);
      
      // If userId is present, add this session to the user's sessions list
      if (session.userId) {
        await this.addSessionToUser(session.userId, session.id);
      }
    } catch (error: unknown) {
      logger.error(`Error saving session ${session.id}:`, error);
      throw new RedisError(`Failed to save session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update a session
   */
  async updateSession(sessionId: string, updates: Partial<SessionData>): Promise<SessionData> {
    const session = await this.getSession(sessionId);
    
    if (!session) {
      throw new SessionError(`Session not found: ${sessionId}`);
    }
    
    const updatedSession: SessionData = {
      ...session,
      ...updates,
      updatedAt: Date.now(),
    };
    
    await this.saveSession(updatedSession);
    logger.info(`Updated session: ${sessionId}`);
    
    return updatedSession;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      // Get the session first to find the userId
      const session = await this.getSession(sessionId);
      // Delete the session
      const key = this.getSessionKey(sessionId);
      const result = await redisService.deleteKey(key);
      
      
      const success = result === 1;
      if (success) {
        logger.info(`Deleted session: ${sessionId}`);
        
        // If userId is present, remove this session from the user's sessions list
        if (session && session.userId) {
          await this.removeSessionFromUser(session.userId, sessionId);
        }
      } else {
        logger.warn(`Session not found for deletion: ${sessionId}`);
      }
      
      return success;
    } catch (error: unknown) {
      logger.error(`Error deleting session ${sessionId}:`, error);
      throw new RedisError(`Failed to delete session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if a session exists
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const key = this.getSessionKey(sessionId);
      return await redisService.keyExists(key);
    } catch (error: unknown) {
      logger.error(`Error checking session existence ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Extend a session's expiration
   */
  async extendSession(sessionId: string, ttlSeconds = this.ttlSeconds): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId);
      
      if (!session) {
        return false;
      }
      
      const now = Date.now();
      session.updatedAt = now;
      session.expiresAt = now + ttlSeconds * 1000;
      
      await this.saveSession(session);
      logger.info(`Extended session: ${sessionId}`);
      
      return true;
    } catch (error: unknown) {
      logger.error(`Error extending session ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<SessionData[]> {
    try {
      const client = redisService.getClient();
      const keys = await client.keys(`${this.sessionKeyPrefix}*`);
      
      if (keys.length === 0) {
        return [];
      }
      
      const sessions: SessionData[] = [];
      for (const key of keys) {
        const data = await redisService.getValue(key);
        if (data) {
          const encryptedSession = JSON.parse(data);
          const session = this.decryptSessionData(encryptedSession);
          sessions.push(session);
        }
      }
      
      return sessions;
    } catch (error: unknown) {
      logger.error('Error listing sessions:', error);
      throw new RedisError(`Failed to list sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * List sessions for a user
   */
  async listUserSessions(userId: string): Promise<SessionData[]> {
    try {
      const userSessionsKey = this.getUserSessionsKey(userId);
      const sessionIds = await redisService.smembers(userSessionsKey);
      
      if (sessionIds.length === 0) {
        return [];
      }
      
      const sessions: SessionData[] = [];
      for (const sessionId of sessionIds) {
        const session = await this.getSession(sessionId);
        if (session) {
          sessions.push(session);
        }
      }
      
      return sessions;
    } catch (error: unknown) {
      logger.error(`Error listing sessions for user ${userId}:`, error);
      throw new RedisError(`Failed to list user sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Update session metadata
   */
  async updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): Promise<SessionData> {
    const session = await this.getSession(sessionId);
    
    if (!session) {
      throw new SessionError(`Session not found: ${sessionId}`);
    }
    
    // Merge the new metadata with existing metadata
    const updatedMetadata = {
      ...session.metadata,
      ...metadata
    };
    
    // Update the session
    const updatedSession = await this.updateSession(sessionId, {
      metadata: updatedMetadata,
      lastUsed: Date.now()
    });
    
    return updatedSession;
  }
  
  /**
   * Add a session to a user's sessions list
   */
  private async addSessionToUser(userId: string, sessionId: string): Promise<void> {
    try {
      const key = this.getUserSessionsKey(userId);
      await redisService.sadd(key, sessionId);
    } catch (error: unknown) {
      logger.error(`Error adding session ${sessionId} to user ${userId}:`, error);
      throw new RedisError(`Failed to add session to user: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Remove a session from a user's sessions list
   */
  private async removeSessionFromUser(userId: string, sessionId: string): Promise<void> {
    try {
      const key = this.getUserSessionsKey(userId);
      await redisService.srem(key, sessionId);
    } catch (error: unknown) {
      logger.error(`Error removing session ${sessionId} from user ${userId}:`, error);
      throw new RedisError(`Failed to remove session from user: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Encrypt sensitive session data
   */
  private encryptSessionData(session: SessionData): SessionData {
    // Create a copy of the session
    const encryptedSession = { ...session };
    
    // Encrypt sensitive fields if they exist
    if (session.authKey) {
      encryptedSession.authKey = this.encrypt(session.authKey);
    }
    
    if (session.phoneNumber) {
      encryptedSession.phoneNumber = this.encrypt(session.phoneNumber);
    }
    
    return encryptedSession;
  }
  
  /**
   * Decrypt sensitive session data
   */
  private decryptSessionData(encryptedSession: SessionData): SessionData {
    // Create a copy of the session
    const session = { ...encryptedSession };
    
    // Decrypt sensitive fields if they exist
    if (encryptedSession.authKey) {
      session.authKey = this.decrypt(encryptedSession.authKey);
    }
    
    if (encryptedSession.phoneNumber) {
      session.phoneNumber = this.decrypt(encryptedSession.phoneNumber);
    }
    
    return session;
  }
  
  /**
   * Encrypt a string
   */
  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }
  
  /**
   * Decrypt a string
   */
  private decrypt(encryptedText: string): string {
    const [ivHex, encryptedHex] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
  
  /**
   * Get Redis key for a session
   */
  private getSessionKey(sessionId: string): string {
    return `${this.sessionKeyPrefix}${sessionId}`;
  }
  
  /**
   * Get Redis key for a user's sessions list
   */
  private getUserSessionsKey(userId: string): string {
    return `${this.userSessionsKeyPrefix}${userId}`;
  }
}

// Export singleton instance
export const sessionStore = new SessionStore();