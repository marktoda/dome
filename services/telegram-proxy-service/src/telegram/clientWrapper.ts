// Using the telegram package instead of gramjs
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Logger } from 'telegram/extensions/Logger';
import { TELEGRAM } from '../config';
import { logger } from '../utils/logger';
import { TelegramError } from '../utils/errors';
import type { SessionData } from '../storage/sessionStore';

// Set logging level
Logger.setLevel('error');
import type {
  TelegramUser,
  TelegramChat,
  TelegramMessage,
  AuthSendCodeResult,
  AuthVerificationResult,
  ChatListResult,
  MessageListResult,
  SendMessageResult,
} from './types';

/**
 * Wrapper for TelegramClient with additional functionality
 */
export class TelegramClientWrapper {
  private client: TelegramClient;
  private sessionData: SessionData | null = null;
  private isConnected = false;
  private id: string;

  /**
   * Create a new TelegramClientWrapper
   */
  constructor(id: string) {
    this.id = id;

    // Set logging level
    Logger.setLevel('error');

    // Create a new TelegramClient with a StringSession
    this.client = new TelegramClient(
      new StringSession(''),
      parseInt(TELEGRAM.API_ID || '0', 10),
      TELEGRAM.API_HASH || '',
      {
        connectionRetries: 5,
      },
    );
  }

  /**
   * Get client ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Check if client is connected
   */
  isClientConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get current session data
   */
  getSessionData(): SessionData | null {
    return this.sessionData;
  }

  /**
   * Connect to Telegram servers
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.client.connect();
      this.isConnected = true;
      logger.info(`Telegram client ${this.id} connected`);
    } catch (error: unknown) {
      logger.error(`Failed to connect Telegram client ${this.id}:`, error);
      throw new TelegramError(
        `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Disconnect from Telegram servers
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.client.disconnect();
      this.isConnected = false;
      this.sessionData = null;
      logger.info(`Telegram client ${this.id} disconnected`);
    } catch (error: unknown) {
      logger.error(`Failed to disconnect Telegram client ${this.id}:`, error);
      // Don't throw here to ensure cleanup happens even if disconnect fails
    }
  }

  /**
   * Use a session with this client
   */
  async useSession(sessionData: SessionData): Promise<void> {
    try {
      // Disconnect if already connected with a different session
      if (this.isConnected && this.sessionData && this.sessionData.id !== sessionData.id) {
        await this.disconnect();
      }

      // Set the session string if available
      if (sessionData.authKey) {
        this.client.session = new StringSession(sessionData.authKey);
      }

      // Connect if not already connected
      if (!this.isConnected) {
        await this.connect();
      }

      this.sessionData = sessionData;
      logger.info(`Telegram client ${this.id} using session ${sessionData.id}`);
    } catch (error: unknown) {
      logger.error(`Failed to use session with Telegram client ${this.id}:`, error);
      throw new TelegramError(
        `Failed to use session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get the underlying TelegramClient
   */
  getClient(): TelegramClient {
    return this.client;
  }

  /**
   * Get the session string
   */
  getSessionString(): string {
    // In telegram package, we need to use toString() on the StringSession
    const stringSession = this.client.session as StringSession;
    return stringSession.toString();
  }

  /**
   * Send a message to a chat
   */
  async sendMessage(chatId: string, message: string): Promise<SendMessageResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        const result = await this.client.sendMessage(chatId, { message });

        // Convert to expected format
        return {
          message: this.convertMessageToTelegramMessage(result),
          users: [], // We don't have users in the result
          chats: [], // We don't have chats in the result
        };
      });
    } catch (error: unknown) {
      logger.error(`Failed to send message to ${chatId}:`, error);
      throw new TelegramError(
        `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get messages from a chat
   */
  async getMessages(chatId: string, limit = 100): Promise<MessageListResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        const result = await this.client.getMessages(chatId, { limit });

        // Convert to expected format
        return {
          messages: Array.isArray(result)
            ? result.map(msg => this.convertMessageToTelegramMessage(msg))
            : [],
          users: [], // We don't have users in the result
          chats: [], // We don't have chats in the result
          count: Array.isArray(result) ? result.length : 0,
        };
      });
    } catch (error: unknown) {
      logger.error(`Failed to get messages from ${chatId}:`, error);
      throw new TelegramError(
        `Failed to get messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get message history from a chat
   */
  async getHistory(chatId: string, limit = 100, offsetId = 0): Promise<MessageListResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        const result = await this.client.getMessages(chatId, {
          limit,
          offsetId,
        });

        // Convert to expected format
        return {
          messages: Array.isArray(result)
            ? result.map(msg => this.convertMessageToTelegramMessage(msg))
            : [],
          users: [], // We don't have users in the result
          chats: [], // We don't have chats in the result
          count: Array.isArray(result) ? result.length : 0,
        };
      });
    } catch (error: unknown) {
      logger.error(`Failed to get history from ${chatId}:`, error);
      throw new TelegramError(
        `Failed to get history: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Send authentication code to a phone number
   * @param phoneNumber The phone number to send the code to (international format)
   * @returns Object containing phone_code_hash and other auth info
   */
  async sendAuthCode(phoneNumber: string): Promise<AuthSendCodeResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        // Normalize phone number (remove + if present)
        const normalizedPhone = phoneNumber.startsWith('+')
          ? phoneNumber.substring(1)
          : phoneNumber;

        // Use type assertion to work around type checking issues
        // The actual API might have changed from what the types suggest
        const result = await (this.client as any).sendCode(
          normalizedPhone,
          parseInt(TELEGRAM.API_ID || '0', 10),
          TELEGRAM.API_HASH || '',
        );

        logger.info(`Sent auth code to ${phoneNumber}`);

        return {
          phoneCodeHash: result.phoneCodeHash,
          timeout: result.timeout || 120,
          isCodeViaApp: Boolean(result.isCodeViaApp) || false,
        };
      });
    } catch (error: unknown) {
      logger.error(`Failed to send auth code to ${phoneNumber}:`, error);
      throw new TelegramError(
        `Failed to send auth code: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Verify the authentication code
   * @param phoneNumber The phone number (international format)
   * @param phoneCodeHash The phone code hash from sendAuthCode
   * @param code The verification code received by the user
   * @returns User information if successful
   */
  async verifyAuthCode(
    phoneNumber: string,
    phoneCodeHash: string,
    code: string,
  ): Promise<AuthVerificationResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        // Normalize phone number (remove + if present)
        const normalizedPhone = phoneNumber.startsWith('+')
          ? phoneNumber.substring(1)
          : phoneNumber;

        try {
          // Sign in with the code using the start method
          await this.client.start({
            phoneNumber: async () => normalizedPhone,
            password: async () => '',
            phoneCode: async () => code,
            onError: (err: Error) => {
              logger.error(`Auth error: ${err}`);
              return Promise.resolve(false);
            },
          });

          // Get user information
          const me = await this.client.getMe();

          // Update session data
          if (this.sessionData) {
            this.sessionData.authKey = this.getSessionString();
            this.sessionData.userId = me.id ? me.id.toString() : undefined;
          }

          logger.info(`Successfully verified auth code for ${phoneNumber}`);

          // Return in the expected format
          return {
            user: this.convertUserToTelegramUser(me),
            sessionData: {
              authKey: this.getSessionString(),
              userId: me.id ? me.id.toString() : '',
            },
          };
        } catch (error: unknown) {
          // Check if we need to provide a password (2FA enabled)
          if (error instanceof Error && error.message.includes('PASSWORD_NEEDED')) {
            logger.info(`2FA password required for ${phoneNumber}`);
            throw new TelegramError('Two-factor authentication required', {
              requiresPassword: true,
            });
          }
          throw error;
        }
      });
    } catch (error: unknown) {
      logger.error(`Failed to verify auth code for ${phoneNumber}:`, error);
      throw new TelegramError(
        `Failed to verify auth code: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Complete 2FA authentication with password
   * @param password The 2FA password
   * @returns User information if successful
   */
  async verify2FAPassword(password: string): Promise<AuthVerificationResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        // In telegram package, we need to use the start method with password
        await this.client.start({
          phoneNumber: async () => '', // Not needed for 2FA
          password: async () => password,
          phoneCode: async () => '', // Not needed for 2FA
          onError: (err: Error) => {
            logger.error(`2FA auth error: ${err}`);
            return Promise.resolve(false);
          },
        });

        // Get user information
        const me = await this.client.getMe();

        // Update session data
        if (this.sessionData) {
          this.sessionData.authKey = this.getSessionString();
          this.sessionData.userId = me.id ? me.id.toString() : undefined;
        }

        logger.info('Successfully verified 2FA password');

        // Create a result object that matches our expected interface
        return {
          user: this.convertUserToTelegramUser(me),
          sessionData: {
            authKey: this.getSessionString(),
            userId: me.id ? me.id.toString() : '',
          },
        };
      });
    } catch (error: unknown) {
      logger.error('Failed to verify 2FA password:', error);
      throw new TelegramError(
        `Failed to verify 2FA password: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  /**
   * Get the current user's information
   * @returns User information
   */
  async getMe(): Promise<TelegramUser> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        const me = await this.client.getMe();
        return this.convertUserToTelegramUser(me);
      });
    } catch (error: unknown) {
      logger.error('Failed to get user information:', error);
      throw new TelegramError(
        `Failed to get user information: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  /**
   * Get the list of chats (dialogs)
   * @param limit Maximum number of chats to retrieve
   * @returns List of chats
   */
  async getChats(limit = 100): Promise<ChatListResult> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        const result = await this.client.getDialogs({
          limit,
        });

        // Convert to expected format
        const chats: TelegramChat[] = [];
        const users: TelegramUser[] = [];

        // Process dialogs to extract chats and users
        if (Array.isArray(result)) {
          for (const dialog of result) {
            if (dialog.entity) {
              chats.push(this.convertChatToTelegramChat(dialog.entity));
            }
          }
        }

        return {
          chats,
          users,
          count: chats.length,
        };
      });
    } catch (error: unknown) {
      logger.error('Failed to get chats:', error);
      throw new TelegramError(
        `Failed to get chats: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get information about a specific chat
   * @param chatId The chat ID
   * @returns Chat information
   */
  async getChat(chatId: string | number): Promise<TelegramChat> {
    try {
      return await this.withRetry(async () => {
        if (!this.isConnected) {
          await this.connect();
        }

        const entity = await this.client.getEntity(chatId);
        return this.convertChatToTelegramChat(entity);
      });
    } catch (error: unknown) {
      logger.error(`Failed to get chat ${chatId}:`, error);
      throw new TelegramError(
        `Failed to get chat: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Execute a function with retry logic
   * @param operation The function to execute
   * @param maxRetries Maximum number of retries
   * @param retryDelay Delay between retries in ms
   * @returns The result of the operation
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    retryDelay = 1000,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        // Check if we need to reconnect
        if (!this.isConnected && attempt > 1) {
          logger.info('Reconnecting before retry attempt');
          await this.connect();
        }

        return await operation();
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry if this is the last attempt
        if (attempt > maxRetries) {
          break;
        }

        // Check if error is retryable
        const isRetryable = this.isRetryableError(lastError);
        if (!isRetryable) {
          logger.warn(`Non-retryable error encountered: ${lastError.message}`);
          break;
        }

        // Log retry attempt
        logger.warn(`Retry attempt ${attempt}/${maxRetries} after error: ${lastError.message}`);

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
      }
    }

    // If we get here, all retries failed
    throw lastError || new Error('Operation failed after retries');
  }

  /**
   * Check if an error is retryable
   * @param error The error to check
   * @returns True if the error is retryable
   */
  private isRetryableError(error: Error): boolean {
    // Network errors are generally retryable
    if (
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENETUNREACH') ||
      error.message.includes('socket hang up') ||
      error.message.includes('network error')
    ) {
      return true;
    }

    // Telegram flood wait errors are retryable
    if (error.message.includes('FLOOD_WAIT_')) {
      return true;
    }

    // Server errors are generally retryable
    if (
      error.message.includes('INTERNAL_SERVER_ERROR') ||
      error.message.includes('SERVER_ERROR') ||
      error.message.includes('GATEWAY_TIMEOUT')
    ) {
      return true;
    }

    // By default, don't retry
    return false;
  }

  /**
   * Reconnect to Telegram servers
   */
  async reconnect(): Promise<void> {
    try {
      logger.info(`Reconnecting Telegram client ${this.id}`);
      await this.disconnect();
      await this.connect();

      // Restore session if available
      if (this.sessionData && this.sessionData.authKey) {
        this.client.session = new StringSession(this.sessionData.authKey);
      }

      logger.info(`Telegram client ${this.id} reconnected`);
    } catch (error: unknown) {
      logger.error(`Failed to reconnect Telegram client ${this.id}:`, error);
      throw new TelegramError(
        `Reconnection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Convert a User object from telegram package to our TelegramUser interface
   */
  private convertUserToTelegramUser(user: any): TelegramUser {
    return {
      id: typeof user.id === 'number' ? user.id : parseInt(user.id.toString(), 10),
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      phone: user.phone,
      bot: user.bot,
      accessHash: user.accessHash ? user.accessHash.toString() : undefined,
    };
  }

  /**
   * Convert a Chat object from telegram package to our TelegramChat interface
   */
  private convertChatToTelegramChat(chat: any): TelegramChat {
    return {
      id: typeof chat.id === 'number' ? chat.id : parseInt(chat.id.toString(), 10),
      title: chat.title,
      username: chat.username,
      accessHash: chat.accessHash ? chat.accessHash.toString() : undefined,
    };
  }

  /**
   * Convert a Message object from telegram package to our TelegramMessage interface
   */
  private convertMessageToTelegramMessage(message: any): TelegramMessage {
    return {
      id: typeof message.id === 'number' ? message.id : parseInt(message.id.toString(), 10),
      message: message.message,
      date: message.date,
    };
  }
}
