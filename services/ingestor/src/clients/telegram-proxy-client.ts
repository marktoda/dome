import { TelegramSession } from './telegram-auth-client';

/**
 * Interface for Telegram Proxy Client configuration
 */
export interface TelegramProxyClientConfig {
  /**
   * Base URL of the Telegram Proxy Service
   */
  baseUrl: string;
  
  /**
   * API key for authentication with the Telegram Proxy Service
   */
  apiKey: string;
  
  /**
   * Maximum number of retries for API calls
   */
  maxRetries?: number;
  
  /**
   * Delay between retries in milliseconds
   */
  retryDelay?: number;
  
  /**
   * Timeout for long polling in seconds
   */
  pollTimeout?: number;
}

/**
 * Interface for message pagination options
 */
export interface MessagePaginationOptions {
  /**
   * Maximum number of messages to retrieve
   */
  limit?: number;
  
  /**
   * Cursor for pagination (message ID)
   */
  cursor?: string;
  
  /**
   * Offset ID for offset-based pagination
   */
  offsetId?: number;
}

/**
 * Interface for message polling options
 */
export interface MessagePollingOptions extends MessagePaginationOptions {
  /**
   * Timeout for long polling in seconds
   */
  timeout?: number;
}

/**
 * Interface for message response
 */
export interface MessageResponse {
  messages: any[];
  users: any[];
  chats: any[];
  pagination?: {
    cursor: string | null;
    nextCursor: string | null;
    count: number;
    hasMore: boolean;
  };
  count?: number;
}

/**
 * Client for interacting with the Telegram Proxy Service
 */
export class TelegramProxyClient {
  private config: TelegramProxyClientConfig;
  private authTokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  
  /**
   * Create a new TelegramProxyClient
   * @param config Client configuration
   */
  constructor(config: TelegramProxyClientConfig) {
    this.config = {
      maxRetries: 3,
      retryDelay: 2000,
      pollTimeout: 10,
      ...config
    };
  }
  
  /**
   * Get messages from a chat
   * @param sessionId Session ID
   * @param chatId Chat ID
   * @param options Pagination options
   * @returns Messages, users, and chats
   */
  async getMessages(
    sessionId: string,
    chatId: string,
    options: MessagePaginationOptions = {}
  ): Promise<MessageResponse> {
    const { limit, cursor } = options;
    
    // Build query parameters
    const queryParams = new URLSearchParams();
    if (limit) queryParams.append('limit', limit.toString());
    if (cursor) queryParams.append('cursor', cursor);
    
    // Build URL
    const url = `${this.config.baseUrl}/api/messages/${chatId}?${queryParams.toString()}`;
    
    // Get auth token for the session
    const token = await this.getAuthToken(sessionId);
    
    // Make request with retry logic
    return this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }
  
  /**
   * Get message history from a chat with offset-based pagination
   * @param sessionId Session ID
   * @param chatId Chat ID
   * @param options Pagination options
   * @returns Messages, users, and chats
   */
  async getMessageHistory(
    sessionId: string,
    chatId: string,
    options: MessagePaginationOptions = {}
  ): Promise<MessageResponse> {
    const { limit, offsetId } = options;
    
    // Build query parameters
    const queryParams = new URLSearchParams();
    if (limit) queryParams.append('limit', limit.toString());
    if (offsetId) queryParams.append('offsetId', offsetId.toString());
    
    // Build URL
    const url = `${this.config.baseUrl}/api/messages/history/${chatId}?${queryParams.toString()}`;
    
    // Get auth token for the session
    const token = await this.getAuthToken(sessionId);
    
    // Make request with retry logic
    return this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }
  
  /**
   * Poll for new messages in a chat
   * @param sessionId Session ID
   * @param chatId Chat ID
   * @param options Polling options
   * @returns New messages, users, and chats
   */
  async pollMessages(
    sessionId: string,
    chatId: string,
    options: MessagePollingOptions = {}
  ): Promise<MessageResponse> {
    const { limit, timeout = this.config.pollTimeout } = options;
    
    // Build query parameters
    const queryParams = new URLSearchParams();
    if (limit) queryParams.append('limit', limit.toString());
    if (timeout) queryParams.append('timeout', timeout.toString());
    
    // Build URL
    const url = `${this.config.baseUrl}/api/messages/poll/${chatId}?${queryParams.toString()}`;
    
    // Get auth token for the session
    const token = await this.getAuthToken(sessionId);
    
    // Make request with retry logic
    return this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }
  
  /**
   * Send a message to a chat
   * @param sessionId Session ID
   * @param chatId Chat ID
   * @param message Message content
   * @returns Result of sending the message
   */
  async sendMessage(
    sessionId: string,
    chatId: string,
    message: string
  ): Promise<any> {
    // Build URL
    const url = `${this.config.baseUrl}/api/messages/${chatId}`;
    
    // Get auth token for the session
    const token = await this.getAuthToken(sessionId);
    
    // Make request with retry logic
    return this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    });
  }
  
  /**
   * Get information about a session
   * @param sessionId Session ID
   * @returns Session information
   */
  async getSessionInfo(sessionId: string): Promise<any> {
    // Build URL
    const url = `${this.config.baseUrl}/api/sessions/${sessionId}`;
    
    // Get auth token for the session
    const token = await this.getAuthToken(sessionId);
    
    // Make request with retry logic
    return this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }
  
  /**
   * Check if a session is valid
   * @param sessionId Session ID
   * @returns Session validity status
   */
  async validateSession(sessionId: string): Promise<boolean> {
    try {
      // Build URL
      const url = `${this.config.baseUrl}/api/sessions/status/${sessionId}`;
      
      // Get auth token for the session
      const token = await this.getAuthToken(sessionId);
      
      // Make request with retry logic
      const response = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      return response.isValid;
    } catch (error) {
      // If there's an error, the session is likely invalid
      return false;
    }
  }
  
  /**
   * Get an authentication token for a session
   * @param sessionId Session ID
   * @returns Authentication token
   */
  private async getAuthToken(sessionId: string): Promise<string> {
    // Check cache first
    const cachedToken = this.authTokenCache.get(sessionId);
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.token;
    }
    
    // If not in cache or expired, get a new token
    // In a real implementation, you would make a request to the auth endpoint
    // For now, we'll use the API key as the token
    const token = this.config.apiKey;
    
    // Cache the token with an expiration time (1 hour)
    this.authTokenCache.set(sessionId, {
      token,
      expiresAt: Date.now() + 3600000 // 1 hour
    });
    
    return token;
  }
  
  /**
   * Make a fetch request with retry logic
   * @param url URL to fetch
   * @param options Fetch options
   * @returns Response data
   */
  private async fetchWithRetry(url: string, options: RequestInit): Promise<any> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      try {
        const response = await fetch(url, options);
        
        if (!response.ok) {
          // Handle rate limiting with exponential backoff
          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
            await this.sleep(retryAfter * 1000);
            continue;
          }
          
          // Handle other errors
          const errorData = await response.json() as { error?: { message: string } };
          throw new Error(errorData.error?.message || `HTTP error ${response.status}`);
        }
        
        const data = await response.json() as { data: any };
        return data.data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't wait on the last attempt
        if (attempt < this.config.maxRetries! - 1) {
          // Exponential backoff with jitter
          const delay = this.config.retryDelay! * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError || new Error('Failed after multiple retry attempts');
  }
  
  /**
   * Sleep for a specified duration
   * @param ms Milliseconds to sleep
   * @returns Promise that resolves after the specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}