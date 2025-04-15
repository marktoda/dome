// Using the telegram package instead of gramjs
import { TelegramClient } from 'telegram';
import { logger } from '../utils/logger';
import { TelegramError, SessionError, NotFoundError } from '../utils/errors';
import { sessionStore, SessionData, UserInfo, SessionMetadata } from '../storage/sessionStore';
import { clientPool } from './clientPool';
import { TelegramClientWrapper } from './clientWrapper';
import { AuthSendCodeResult, AuthVerificationResult, TelegramUser } from './types';
import { SESSION } from '../config';

/**
 * Interface for phone code request result
 */
export interface PhoneCodeRequestResult extends AuthSendCodeResult {}

/**
 * Interface for authentication result
 */
export interface AuthResult {
  success: boolean;
  sessionId: string;
  userId?: string;
  error?: string;
  requiresPassword?: boolean;
}

/**
 * Interface for session validation result
 */
export interface SessionValidationResult {
  valid: boolean;
  session?: SessionData;
  error?: string;
}

/**
 * Interface for session operation options
 */
export interface SessionOperationOptions {
  timeout?: number;
  priority?: number;
  retries?: number;
}

/**
 * Manager for Telegram sessions
 */
export class SessionManager {
  private readonly defaultSessionTtl: number;
  
  constructor(defaultSessionTtl = SESSION.TTL_SECONDS) {
    this.defaultSessionTtl = defaultSessionTtl;
  }
  /**
   * Start a new authentication flow
   */
  async startAuthFlow(phoneNumber: string): Promise<PhoneCodeRequestResult> {
    let client: TelegramClientWrapper | null = null;
    
    try {
      // Acquire a client from the pool
      client = await clientPool.acquire();
      
      // Send the code using our wrapper method
      const result = await client.sendAuthCode(phoneNumber);
      
      logger.info(`Sent authentication code to ${phoneNumber}`);
      
      return result;
    } catch (error: unknown) {
      logger.error(`Failed to start auth flow for ${phoneNumber}:`, error);
      throw new TelegramError(`Failed to send authentication code: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Release the client back to the pool
      if (client) {
        clientPool.release(client.getId());
      }
    }
  }

  /**
   * Complete authentication with the provided code
   */
  async completeAuth(
    phoneNumber: string,
    phoneCode: string,
    phoneCodeHash: string
  ): Promise<AuthResult> {
    let client: TelegramClientWrapper | null = null;
    
    try {
      // Acquire a client from the pool
      client = await clientPool.acquire();
      
      // Sign in with the code using our wrapper method
      const signInResult = await client.verifyAuthCode(phoneNumber, phoneCodeHash, phoneCode);
      
      // Get the session string
      const sessionString = client.getSessionString();
      
      // Create a session in the store
      const session = await sessionStore.createSession({
        phoneNumber,
        authKey: sessionString,
        userId: signInResult.user.id?.toString(),
        metadata: {
          firstName: signInResult.user.firstName,
          lastName: signInResult.user.lastName,
          username: signInResult.user.username,
        },
      });
      
      logger.info(`Authentication completed for ${phoneNumber}, session ID: ${session.id}`);
      
      return {
        success: true,
        sessionId: session.id,
        userId: signInResult.user.id?.toString(),
      };
    } catch (error: unknown) {
      logger.error(`Failed to complete auth for ${phoneNumber}:`, error);
      
      // Check if this is a 2FA error
      if (error instanceof TelegramError && 
          error.details && 
          error.details.requiresPassword) {
        return {
          success: false,
          sessionId: '',
          error: 'Two-factor authentication required',
          requiresPassword: true
        };
      }
      
      return {
        success: false,
        sessionId: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      // Release the client back to the pool
      if (client) {
        clientPool.release(client.getId());
      }
    }
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<SessionData> {
    const session = await sessionStore.getSession(sessionId);
    
    if (!session) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
    
    // Update last used time
    if (session) {
      await this.touchSession(sessionId);
    }
    
    return session;
  }
  
  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<SessionData[]> {
    try {
      return await sessionStore.listUserSessions(userId);
    } catch (error: unknown) {
      logger.error(`Failed to get sessions for user ${userId}:`, error);
      throw new SessionError(`Failed to get user sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if a session is valid
   */
  async validateSession(sessionId: string): Promise<SessionValidationResult> {
    let client: TelegramClientWrapper | null = null;
    
    try {
      // Get the session
      const session = await this.getSession(sessionId);
      
      // Check if session is expired
      if (session.expiresAt < Date.now()) {
        return {
          valid: false,
          error: 'Session expired'
        };
      }
      
      // Check if session is active
      if (!session.isActive) {
        return {
          valid: false,
          error: 'Session is inactive'
        };
      }
      
      // Acquire a client from the pool
      client = await clientPool.acquire(session);
      
      // Try to get the user to validate the session
      await client.getMe();
      
      // Extend the session
      await this.refreshSession(sessionId);
      
      return {
        valid: true,
        session
      };
    } catch (error: unknown) {
      logger.error(`Session validation failed for ${sessionId}:`, error);
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      // Release the client back to the pool
      if (client) {
        clientPool.release(client.getId());
      }
    }
  }

  /**
   * Revoke a session
   */
  async revokeSession(sessionId: string): Promise<boolean> {
    try {
      // Delete the session from the store
      const result = await sessionStore.deleteSession(sessionId);
      
      if (result) {
        logger.info(`Session revoked: ${sessionId}`);
      }
      
      return result;
    } catch (error: unknown) {
      logger.error(`Failed to revoke session ${sessionId}:`, error);
      throw new SessionError(`Failed to revoke session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Refresh a session's expiration
   */
  async refreshSession(sessionId: string, ttlSeconds?: number): Promise<boolean> {
    try {
      const result = await sessionStore.extendSession(sessionId, ttlSeconds || this.defaultSessionTtl);
      
      if (result) {
        logger.info(`Session refreshed: ${sessionId}`);
      }
      
      return result;
    } catch (error: unknown) {
      logger.error(`Failed to refresh session ${sessionId}:`, error);
      throw new SessionError(`Failed to refresh session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Terminate a session (alias for revokeSession for backward compatibility)
   * @deprecated Use revokeSession instead
   */
  async terminateSession(sessionId: string): Promise<boolean> {
    return this.revokeSession(sessionId);
  }
  
  /**
   * Execute an operation with a session (alias for executeWithSession for backward compatibility)
   * @deprecated Use executeWithSession instead
   */
  async withSession<T>(
    sessionId: string,
    operation: (client: TelegramClientWrapper) => Promise<T>
  ): Promise<T> {
    return this.executeWithSession(sessionId, operation);
  }
  
  /**
   * Update session's last used timestamp
   */
  async touchSession(sessionId: string): Promise<void> {
    try {
      await sessionStore.updateSession(sessionId, {
        lastUsed: Date.now()
      });
    } catch (error: unknown) {
      // Just log the error but don't throw
      logger.warn(`Failed to update session last used time ${sessionId}:`, error);
    }
  }

  /**
   * Execute an operation with a session
   */
  async executeWithSession<T>(
    sessionId: string,
    operation: (client: TelegramClientWrapper) => Promise<T>,
    options: SessionOperationOptions = {}
  ): Promise<T> {
    let client: TelegramClientWrapper | null = null;
    
    try {
      // Validate the session first
      const validationResult = await this.validateSession(sessionId);
      
      if (!validationResult.valid) {
        throw new SessionError(`Invalid session: ${validationResult.error}`);
      }
      
      // Get the session
      const session = await this.getSession(sessionId);
      // Acquire a client from the pool with options
      client = await clientPool.acquire(
        session,
        options.priority || 0
      );
      
      // Execute the operation
      const result = await operation(client);
      
      // Update the session with the latest auth key and metadata
      await sessionStore.updateSession(sessionId, {
        authKey: client.getSessionString(),
        updatedAt: Date.now(),
        lastUsed: Date.now(),
      });
      
      return result;
    } catch (error: unknown) {
      logger.error(`Operation failed for session ${sessionId}:`, error);
      throw new TelegramError(`Operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Release the client back to the pool
      if (client) {
        clientPool.release(client.getId());
      }
    }
  }

  /**
   * Complete 2FA authentication
   */
  async complete2FAAuth(
    sessionId: string,
    password: string
  ): Promise<AuthResult> {
    let client: TelegramClientWrapper | null = null;
    
    try {
      // Get the session
      const session = await this.getSession(sessionId);
      
      // Acquire a client from the pool
      client = await clientPool.acquire(session);
      
      // Verify the password
      const result = await client.verify2FAPassword(password);
      
      // Update the session
      await sessionStore.updateSession(sessionId, {
        authKey: client.getSessionString(),
        userId: result.user.id?.toString(),
        updatedAt: Date.now(),
      });
      
      logger.info(`2FA authentication completed for session ${sessionId}`);
      
      return {
        success: true,
        sessionId,
        userId: result.user.id?.toString(),
      };
    } catch (error: unknown) {
      logger.error(`Failed to complete 2FA auth for session ${sessionId}:`, error);
      
      return {
        success: false,
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      // Release the client back to the pool
      if (client) {
        clientPool.release(client.getId());
      }
    }
  }
  /**
   * Create a new session
   */
  async createSession(userData: Partial<UserInfo> = {}): Promise<SessionData> {
    try {
      // Create a session with user data
      const session = await sessionStore.createSession({
        userId: userData.id,
        phoneNumber: userData.phoneNumber,
        metadata: {
          userInfo: {
            firstName: userData.firstName,
            lastName: userData.lastName,
            username: userData.username
          },
          createdAt: Date.now()
        }
      });
      
      logger.info(`Created new session: ${session.id} for user: ${userData.id || 'unknown'}`);
      return session;
    } catch (error: unknown) {
      logger.error('Failed to create session:', error);
      throw new SessionError(`Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Update session metadata
   */
  async updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): Promise<SessionData> {
    try {
      return await sessionStore.updateSessionMetadata(sessionId, metadata);
    } catch (error: unknown) {
      logger.error(`Failed to update session metadata for ${sessionId}:`, error);
      throw new SessionError(`Failed to update session metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    try {
      const sessions = await sessionStore.listSessions();
      const now = Date.now();
      let removedCount = 0;
      
      for (const session of sessions) {
        if (session.expiresAt < now) {
          await sessionStore.deleteSession(session.id);
          removedCount++;
        }
      }
      
      if (removedCount > 0) {
        logger.info(`Cleaned up ${removedCount} expired sessions`);
      }
      
      return removedCount;
    } catch (error: unknown) {
      logger.error('Failed to clean up expired sessions:', error);
      throw new SessionError(`Failed to clean up expired sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// Export singleton instance
export const sessionManager = new SessionManager();