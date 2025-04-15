/**
 * Authentication Handler
 */
import { TelegramClientWrapper, SendCodeResult, VerifyCodeResult } from '../lib/telegram-client';
import { SessionManager } from '../lib/session-manager';
import { TelegramUser, TelegramUserDTO, fromDTO as userFromDTO } from '../models/user';

/**
 * Authentication Handler class
 */
export class TelegramAuthHandler {
  private telegramClient: TelegramClientWrapper;
  private sessionManager?: SessionManager;
  private db?: D1Database;
  
  /**
   * Constructor
   * @param apiId - Telegram API ID
   * @param apiHash - Telegram API Hash
   * @param db - Optional D1 database instance
   * @param sessionSecret - Optional session secret for session manager
   */
  constructor(
    apiId: string,
    apiHash: string,
    db?: D1Database,
    sessionSecret?: string
  ) {
    this.telegramClient = new TelegramClientWrapper(apiId, apiHash);
    
    if (db && sessionSecret) {
      this.db = db;
      this.sessionManager = new SessionManager(db, sessionSecret);
    }
  }
  
  /**
   * Send authentication code to phone number
   * @param phoneNumber - The phone number to send code to
   * @returns SendCodeResult with code hash and other details
   */
  async sendAuthCode(phoneNumber: string): Promise<SendCodeResult> {
    try {
      // Send the code via Telegram client
      return await this.telegramClient.sendAuthCode(phoneNumber);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error sending auth code: ${errorMessage}`);
      throw new Error(`Failed to send authentication code: ${errorMessage}`);
    }
  }
  
  /**
   * Verify authentication code
   * @param phoneNumber - The phone number
   * @param phoneCodeHash - The phone code hash from sendAuthCode
   * @param code - The authentication code received by the user
   * @param deviceInfo - Optional device information
   * @param ipAddress - Optional IP address
   * @returns Object with session ID and expiration date
   */
  async verifyAuthCode(
    phoneNumber: string,
    phoneCodeHash: string,
    code: string,
    deviceInfo?: string,
    ipAddress?: string
  ): Promise<{ sessionId: string; expiresAt: Date }> {
    if (!this.db || !this.sessionManager) {
      throw new Error('Database and session manager are required for verifyAuthCode');
    }
    
    try {
      // Verify the code via Telegram client
      const result = await this.telegramClient.verifyAuthCode(
        phoneNumber,
        phoneCodeHash,
        code
      );
      
      // Get or create user in database
      const user = await this.getOrCreateUser(
        result.userId,
        phoneNumber,
        result.firstName,
        result.lastName,
        result.username
      );
      
      // Save the session
      const sessionId = await this.sessionManager.saveSession(
        user.id,
        result.sessionString,
        deviceInfo,
        ipAddress
      );
      
      // Calculate expiration date (30 days from now)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      
      return {
        sessionId,
        expiresAt
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error verifying auth code: ${errorMessage}`);
      throw new Error(`Failed to verify authentication code: ${errorMessage}`);
    }
  }
  
  /**
   * Get or create a user in the database
   * @param telegramId - The Telegram user ID
   * @param phoneNumber - The phone number
   * @param firstName - Optional first name
   * @param lastName - Optional last name
   * @param username - Optional username
   * @returns The user object
   */
  private async getOrCreateUser(
    telegramId: number,
    phoneNumber: string,
    firstName?: string,
    lastName?: string,
    username?: string
  ): Promise<TelegramUser> {
    if (!this.db) {
      throw new Error('Database is required for getOrCreateUser');
    }
    
    // Try to find existing user by phone number
    const existingUser = await this.db.prepare(`
      SELECT * FROM telegram_users
      WHERE phone_number = ?
    `).bind(phoneNumber).first<TelegramUserDTO>();
    
    if (existingUser) {
      // Update user information if needed
      await this.db.prepare(`
        UPDATE telegram_users
        SET telegram_id = ?, first_name = ?, last_name = ?, username = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        telegramId,
        firstName || null,
        lastName || null,
        username || null,
        existingUser.id
      ).run();
      
      // Return updated user
      return {
        ...userFromDTO(existingUser),
        telegramId,
        firstName,
        lastName,
        username,
        updatedAt: new Date()
      };
    }
    
    // Create new user
    const now = new Date().toISOString();
    const result = await this.db.prepare(`
      INSERT INTO telegram_users (
        phone_number, telegram_id, first_name, last_name, username,
        access_level, is_blocked, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        1, 0, ?, ?
      )
      RETURNING *
    `).bind(
      phoneNumber,
      telegramId,
      firstName || null,
      lastName || null,
      username || null,
      now,
      now
    ).first<TelegramUserDTO>();
    
    if (!result) {
      throw new Error('Failed to create user');
    }
    
    return userFromDTO(result);
  }
  
  /**
   * Get a user by ID
   * @param userId - The user ID
   * @returns The user object
   */
  async getUserById(userId: number): Promise<TelegramUser> {
    if (!this.db) {
      throw new Error('Database is required for getUserById');
    }
    
    const user = await this.db.prepare(`
      SELECT * FROM telegram_users
      WHERE id = ?
    `).bind(userId).first<TelegramUserDTO>();
    
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    
    return userFromDTO(user);
  }
  
  /**
   * Get a user by phone number
   * @param phoneNumber - The phone number
   * @returns The user object
   */
  async getUserByPhoneNumber(phoneNumber: string): Promise<TelegramUser> {
    if (!this.db) {
      throw new Error('Database is required for getUserByPhoneNumber');
    }
    
    const user = await this.db.prepare(`
      SELECT * FROM telegram_users
      WHERE phone_number = ?
    `).bind(phoneNumber).first<TelegramUserDTO>();
    
    if (!user) {
      throw new Error(`User not found with phone number: ${phoneNumber}`);
    }
    
    return userFromDTO(user);
  }
  
  /**
   * Get the session manager
   * @returns The session manager
   */
  getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error('Session manager not initialized');
    }
    
    return this.sessionManager;
  }
}