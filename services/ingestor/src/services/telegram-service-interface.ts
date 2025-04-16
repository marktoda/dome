/**
 * Interface for Telegram services
 * This interface defines the common methods that both TelegramService and TelegramProxyService implement
 */
export interface ITelegramService {
  /**
   * Collect messages from a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @param options Collection options
   * @returns Collected messages
   */
  collectMessages(
    userId: number,
    source: string,
    options?: { limit?: number; offsetId?: number },
  ): Promise<any[]>;

  /**
   * Collect media from a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @param options Collection options
   * @returns Collected media items
   */
  collectMedia(
    userId: number,
    source: string,
    options?: { limit?: number; offsetId?: number; mediaType?: string },
  ): Promise<any[]>;

  /**
   * Get information about a Telegram channel or chat
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @returns Channel or chat information
   */
  getSourceInfo(userId: number, source: string): Promise<any>;

  /**
   * Poll for new messages in a Telegram channel or chat
   * This method is optional and may not be implemented by all services
   * @param userId User ID to use for authentication
   * @param source Channel or chat identifier
   * @param options Polling options
   * @returns New messages
   */
  pollMessages?(
    userId: number,
    source: string,
    options?: { timeout?: number; limit?: number },
  ): Promise<any[]>;
}
