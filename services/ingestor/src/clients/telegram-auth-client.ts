/**
 * Interface for Telegram session data
 */
export interface TelegramSession {
  sessionString: string;
  userId: number;
  expiresAt: string;
}

/**
 * Interface for Telegram auth client configuration
 */
export interface TelegramAuthClientConfig {
  telegramAuth: any; // Service binding
  serviceId: string;
  retryAttempts?: number;
  retryDelay?: number;
}

/**
 * Client for interacting with the Telegram Authentication Service
 * Uses Cloudflare service bindings for direct RPC calls
 */
export class TelegramAuthClient {
  private config: TelegramAuthClientConfig;
  private sessionCache: Map<number, TelegramSession> = new Map();

  /**
   * Create a new TelegramAuthClient
   * @param config Client configuration
   */
  constructor(config: TelegramAuthClientConfig) {
    this.config = {
      retryAttempts: 3,
      retryDelay: 1000,
      ...config
    };
  }

  /**
   * Get a Telegram session for a user
   * @param userId User ID
   * @returns Telegram session
   */
  async getSession(userId: number): Promise<TelegramSession> {
    // Check cache first
    const cachedSession = this.sessionCache.get(userId);
    if (cachedSession && this.isSessionValid(cachedSession)) {
      return cachedSession;
    }

    // Fetch from auth service using service binding
    const session = await this.fetchSession(userId);
    
    // Cache the session
    this.sessionCache.set(userId, session);
    
    return session;
  }

  /**
   * Check if a session is valid (not expired)
   * @param session Telegram session
   * @returns True if session is valid
   */
  private isSessionValid(session: TelegramSession): boolean {
    const expiresAt = new Date(session.expiresAt);
    const now = new Date();
    
    // Consider session invalid if it expires in less than 5 minutes
    const fiveMinutes = 5 * 60 * 1000;
    return expiresAt.getTime() - now.getTime() > fiveMinutes;
  }

  /**
   * Fetch a session from the auth service using service binding
   * @param userId User ID
   * @returns Telegram session
   */
  private async fetchSession(userId: number): Promise<TelegramSession> {
    let lastError: Error | null = null;
    
    // Retry logic
    for (let attempt = 0; attempt < this.config.retryAttempts!; attempt++) {
      try {
        // Use service binding to directly call the method
        const sessionData = await this.config.telegramAuth.getSessionByUserId(userId);
        
        return {
          sessionString: sessionData.sessionString,
          userId: userId,
          expiresAt: sessionData.expiresAt
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't wait on the last attempt
        if (attempt < this.config.retryAttempts! - 1) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay!));
        }
      }
    }
    
    throw lastError || new Error('Failed to get session after multiple attempts');
  }

  /**
   * Refresh a session for a user
   * @param userId User ID
   * @returns Refreshed Telegram session
   */
  async refreshSession(userId: number): Promise<TelegramSession> {
    // Remove from cache
    this.sessionCache.delete(userId);
    
    // Fetch fresh session
    return this.fetchSession(userId);
  }

  /**
   * Clear the session cache
   */
  clearCache(): void {
    this.sessionCache.clear();
  }

  /**
   * Revoke a session
   * @param sessionId Session ID
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.config.telegramAuth.revokeSession(sessionId);
  }
}