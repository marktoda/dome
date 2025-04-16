import type { TelegramAuthClient, TelegramSession } from '../clients/telegram-auth-client';
import type {
  TelegramProxyClient,
  MessagePaginationOptions,
  MessagePollingOptions,
} from '../clients/telegram-proxy-client';
import type { ITelegramService } from './telegram-service-interface';

/**
 * Interface for Telegram Proxy Service configuration
 */
export interface TelegramProxyServiceConfig {
  /**
   * Telegram API ID (from my.telegram.org)
   */
  telegramApiId: number;

  /**
   * Telegram API Hash (from my.telegram.org)
   */
  telegramApiHash: string;

  /**
   * Auth client for getting sessions
   */
  authClient: TelegramAuthClient;

  /**
   * Proxy client for interacting with the Telegram Proxy Service
   */
  proxyClient: TelegramProxyClient;

  /**
   * Maximum number of retries for API calls
   */
  maxRetries?: number;

  /**
   * Delay between retries in milliseconds
   */
  retryDelay?: number;

  /**
   * Default polling interval in milliseconds
   */
  defaultPollingInterval?: number;

  /**
   * Feature flag to enable/disable proxy integration
   */
  useProxyService?: boolean;
}

/**
 * Service for interacting with Telegram using the Telegram Proxy Service
 */
export class TelegramProxyService implements ITelegramService {
  private config: TelegramProxyServiceConfig;
  private sessionCache: Map<number, { session: TelegramSession; sessionId: string }> = new Map();

  /**
   * Create a new TelegramProxyService
   * @param config Service configuration
   */
  constructor(config: TelegramProxyServiceConfig) {
    this.config = {
      maxRetries: 3,
      retryDelay: 2000,
      defaultPollingInterval: 5000, // 5 seconds
      useProxyService: true, // Enable by default
      ...config,
    };
  }

  /**
   * Collect messages from a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @param options Collection options
   * @returns Collected messages
   */
  async collectMessages(
    userId: number,
    source: string,
    options: MessagePaginationOptions = {},
  ): Promise<any[]> {
    // If proxy service is disabled, throw an error
    if (!this.config.useProxyService) {
      throw new Error('Telegram Proxy Service integration is disabled');
    }

    try {
      // Get session and session ID for the user
      const { session, sessionId } = await this.getSessionWithRetry(userId);

      // Use the proxy client to get messages
      const response = await this.config.proxyClient.getMessages(sessionId, source, options);

      return response.messages;
    } catch (error) {
      // Handle specific Telegram errors
      if (this.isSessionExpiredError(error)) {
        // Refresh the session and retry
        await this.refreshSession(userId);
        return this.collectMessages(userId, source, options);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Collect media from a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @param options Collection options
   * @returns Collected media items
   */
  async collectMedia(
    userId: number,
    source: string,
    options: { limit?: number; offsetId?: number; mediaType?: string } = {},
  ): Promise<any[]> {
    // If proxy service is disabled, throw an error
    if (!this.config.useProxyService) {
      throw new Error('Telegram Proxy Service integration is disabled');
    }

    try {
      // Get session and session ID for the user
      const { session, sessionId } = await this.getSessionWithRetry(userId);

      // Use the proxy client to get messages with media
      const response = await this.config.proxyClient.getMessageHistory(sessionId, source, {
        limit: options.limit,
        offsetId: options.offsetId,
      });

      // Filter messages to only include those with media of the specified type
      const mediaMessages = response.messages.filter(msg => {
        // Check if the message has media
        const hasMedia =
          msg.media &&
          (!options.mediaType || // If no media type specified, include all media
            (options.mediaType === 'photo' && msg.media.photo) ||
            (options.mediaType === 'video' &&
              msg.media.document &&
              msg.media.document.mimeType?.startsWith('video/')) ||
            (options.mediaType === 'document' && msg.media.document));

        return hasMedia;
      });

      // Extract media information
      return mediaMessages.map(msg => {
        // Basic media info
        const mediaInfo: any = {
          id: msg.id,
          date: msg.date,
          chatId: source,
        };

        // Add media-specific information
        if (msg.media.photo) {
          mediaInfo.type = 'photo';
          mediaInfo.sizes = msg.media.photo.sizes;
        } else if (msg.media.document) {
          if (msg.media.document.mimeType?.startsWith('video/')) {
            mediaInfo.type = 'video';
          } else {
            mediaInfo.type = 'document';
          }

          mediaInfo.fileName = msg.media.document.fileName;
          mediaInfo.mimeType = msg.media.document.mimeType;
          mediaInfo.fileSize = msg.media.document.fileSize;
        }

        return mediaInfo;
      });
    } catch (error) {
      // Handle specific Telegram errors
      if (this.isSessionExpiredError(error)) {
        // Refresh the session and retry
        await this.refreshSession(userId);
        return this.collectMedia(userId, source, options);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Get information about a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @returns Channel or chat information
   */
  async getSourceInfo(userId: number, source: string): Promise<any> {
    // If proxy service is disabled, throw an error
    if (!this.config.useProxyService) {
      throw new Error('Telegram Proxy Service integration is disabled');
    }

    try {
      // Get session and session ID for the user
      const { session, sessionId } = await this.getSessionWithRetry(userId);

      // Use the proxy client to get messages (we'll extract chat info from the response)
      const response = await this.config.proxyClient.getMessages(sessionId, source, { limit: 1 });

      // Find the chat in the response
      const chatInfo = response.chats.find(
        (chat: any) => chat.id.toString() === source || chat.username === source,
      );

      if (!chatInfo) {
        throw new Error(`Chat or channel not found: ${source}`);
      }

      // Extract relevant information
      return {
        id: chatInfo.id,
        title: chatInfo.title,
        username: chatInfo.username,
        memberCount: chatInfo.participantsCount,
        description: chatInfo.about,
      };
    } catch (error) {
      // Handle specific Telegram errors
      if (this.isSessionExpiredError(error)) {
        // Refresh the session and retry
        await this.refreshSession(userId);
        return this.getSourceInfo(userId, source);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Poll for new messages in a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @param options Polling options
   * @returns New messages
   */
  async pollMessages(
    userId: number,
    source: string,
    options: MessagePollingOptions = {},
  ): Promise<any[]> {
    // If proxy service is disabled, throw an error
    if (!this.config.useProxyService) {
      throw new Error('Telegram Proxy Service integration is disabled');
    }

    try {
      // Get session and session ID for the user
      const { session, sessionId } = await this.getSessionWithRetry(userId);

      // Use the proxy client to poll for messages
      const response = await this.config.proxyClient.pollMessages(sessionId, source, options);

      return response.messages;
    } catch (error) {
      // Handle specific Telegram errors
      if (this.isSessionExpiredError(error)) {
        // Refresh the session and retry
        await this.refreshSession(userId);
        return this.pollMessages(userId, source, options);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Get a session with retry logic
   * @param userId User ID
   * @returns Telegram session and session ID
   */
  private async getSessionWithRetry(
    userId: number,
  ): Promise<{ session: TelegramSession; sessionId: string }> {
    // Check cache first
    const cachedSession = this.sessionCache.get(userId);
    if (cachedSession) {
      return cachedSession;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      try {
        // Get session from auth client
        const session = await this.config.authClient.getSession(userId);

        // Generate a session ID (in a real implementation, this would be provided by the auth service)
        const sessionId = `session_${userId}_${Date.now()}`;

        // Cache the session
        const sessionData = { session, sessionId };
        this.sessionCache.set(userId, sessionData);

        return sessionData;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't wait on the last attempt
        if (attempt < this.config.maxRetries! - 1) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        }
      }
    }

    throw lastError || new Error('Failed to get session after multiple attempts');
  }

  /**
   * Refresh a session for a user
   * @param userId User ID
   * @returns Refreshed session and session ID
   */
  private async refreshSession(
    userId: number,
  ): Promise<{ session: TelegramSession; sessionId: string }> {
    // Remove from cache
    this.sessionCache.delete(userId);

    // Get a fresh session
    return this.getSessionWithRetry(userId);
  }

  /**
   * Check if an error indicates an expired session
   * @param error Error to check
   * @returns True if the error indicates an expired session
   */
  private isSessionExpiredError(error: any): boolean {
    // In a real implementation, you would check for specific error codes or messages
    // that indicate an expired session
    const errorMessage = error instanceof Error ? error.message : String(error);
    return (
      errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
      errorMessage.includes('SESSION_REVOKED') ||
      errorMessage.includes('AUTH_KEY_PERM_EMPTY') ||
      errorMessage.includes('SESSION_EXPIRED') ||
      errorMessage.includes('UNAUTHORIZED')
    );
  }

  /**
   * Enable or disable the Telegram Proxy Service integration
   * @param enabled Whether to enable the integration
   */
  setProxyServiceEnabled(enabled: boolean): void {
    this.config.useProxyService = enabled;
  }

  /**
   * Check if the Telegram Proxy Service integration is enabled
   * @returns True if the integration is enabled
   */
  isProxyServiceEnabled(): boolean {
    return this.config.useProxyService === true;
  }
}
