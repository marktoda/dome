/**
 * Session Manager for Telegram Authentication
 */
import { TelegramSession, TelegramSessionDTO, fromDTO as sessionFromDTO, toDTO as sessionToDTO } from '../models/session';
import { encrypt, decrypt, generateRandomString } from '../utils/crypto';

/**
 * Memory cache for sessions
 */
interface SessionCache {
  [key: string]: {
    session: TelegramSession;
    expiresAt: Date;
  };
}

/**
 * Session Manager class
 */
export class SessionManager {
  private db: D1Database;
  private sessionSecret: string;
  private memoryCache: SessionCache = {};
  private cacheTTL: number = 15 * 60 * 1000; // 15 minutes in milliseconds
  
  /**
   * Constructor
   * @param db - D1 database instance
   * @param sessionSecret - Secret key for session encryption
   */
  constructor(db: D1Database, sessionSecret: string) {
    this.db = db;
    this.sessionSecret = sessionSecret;
  }
  
  /**
   * Save a new session
   * @param userId - The user ID
   * @param sessionString - The session string from Telegram
   * @param deviceInfo - Optional device information
   * @param ipAddress - Optional IP address
   * @returns The session ID
   */
  async saveSession(
    userId: number,
    sessionString: string,
    deviceInfo?: string,
    ipAddress?: string
  ): Promise<string> {
    // Generate a unique session ID
    const sessionId = `${userId}_${generateRandomString(16)}`;
    
    // Generate a unique salt for this session
    const salt = generateRandomString(16);
    
    // Encrypt the session data
    const { encryptedData, iv } = await encrypt(
      sessionString,
      this.sessionSecret,
      salt
    );
    
    // Calculate expiration date (30 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    
    // Create the session object
    const session: TelegramSession = {
      id: sessionId,
      userId,
      encryptedData,
      iv,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt,
      isActive: true,
      deviceInfo,
      ipAddress
    };
    
    // Convert to DTO for database
    const sessionDTO = sessionToDTO(session);
    
    // Insert into database
    await this.db.prepare(`
      INSERT INTO telegram_sessions (
        id, user_id, encrypted_data, iv, version, 
        created_at, updated_at, last_used_at, expires_at, 
        is_active, device_info, ip_address
      ) VALUES (
        ?, ?, ?, ?, ?, 
        ?, ?, ?, ?, 
        ?, ?, ?
      )
    `).bind(
      sessionDTO.id,
      sessionDTO.user_id,
      sessionDTO.encrypted_data,
      sessionDTO.iv,
      sessionDTO.version,
      sessionDTO.created_at,
      sessionDTO.updated_at,
      sessionDTO.last_used_at,
      sessionDTO.expires_at,
      sessionDTO.is_active ? 1 : 0,
      sessionDTO.device_info || null,
      sessionDTO.ip_address || null
    ).run();
    
    // Add to memory cache
    this.addToCache(session);
    
    return sessionId;
  }
  
  /**
   * Get a session by ID
   * @param sessionId - The session ID
   * @returns The decrypted session string
   */
  async getSession(sessionId: string): Promise<string> {
    // Check memory cache first
    const cachedSession = this.getFromCache(sessionId);
    if (cachedSession) {
      return this.decryptSession(cachedSession);
    }
    
    // Get from database
    const result = await this.db.prepare(`
      SELECT * FROM telegram_sessions 
      WHERE id = ? AND is_active = 1 AND expires_at > datetime('now')
    `).bind(sessionId).first<TelegramSessionDTO>();
    
    if (!result) {
      throw new Error(`Session not found or expired: ${sessionId}`);
    }
    
    // Convert to model
    const session = sessionFromDTO(result);
    
    // Add to memory cache
    this.addToCache(session);
    
    // Update last used timestamp
    await this.updateLastUsed(sessionId);
    
    // Decrypt and return
    return this.decryptSession(session);
  }
  
  /**
   * Get a session by user ID
   * @param userId - The user ID
   * @returns The session and its ID
   */
  async getSessionByUserId(userId: number): Promise<{ sessionString: string; sessionId: string; expiresAt: Date }> {
    // Get from database
    const result = await this.db.prepare(`
      SELECT * FROM telegram_sessions 
      WHERE user_id = ? AND is_active = 1 AND expires_at > datetime('now')
      ORDER BY last_used_at DESC
      LIMIT 1
    `).bind(userId).first<TelegramSessionDTO>();
    
    if (!result) {
      throw new Error(`No active session found for user: ${userId}`);
    }
    
    // Convert to model
    const session = sessionFromDTO(result);
    
    // Add to memory cache
    this.addToCache(session);
    
    // Update last used timestamp
    await this.updateLastUsed(session.id);
    
    // Decrypt
    const sessionString = await this.decryptSession(session);
    
    return {
      sessionString,
      sessionId: session.id,
      expiresAt: session.expiresAt || new Date()
    };
  }
  
  /**
   * Revoke a session
   * @param sessionId - The session ID
   */
  async revokeSession(sessionId: string): Promise<void> {
    // Update database
    const result = await this.db.prepare(`
      UPDATE telegram_sessions
      SET is_active = 0, updated_at = datetime('now')
      WHERE id = ?
    `).bind(sessionId).run();
    // Check if the session was found and updated
    // Note: D1Result might not have a changes property in the type definition
    // but it's available at runtime
    const changes = (result as any).changes || 0;
    if (changes === 0) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    // Remove from cache
    delete this.memoryCache[sessionId];
  }
  
  /**
   * List all sessions for a user
   * @param userId - The user ID
   * @returns Array of sessions
   */
  async listSessions(userId: number): Promise<TelegramSession[]> {
    // Get from database
    const results = await this.db.prepare(`
      SELECT * FROM telegram_sessions 
      WHERE user_id = ?
      ORDER BY last_used_at DESC
    `).bind(userId).all<TelegramSessionDTO>();
    
    // Convert to models
    return results.results.map(sessionFromDTO);
  }
  
  /**
   * Log session access
   * @param sessionId - The session ID
   * @param serviceName - The name of the service accessing the session
   * @param action - The action being performed
   * @param success - Whether the access was successful
   * @param errorMessage - Optional error message
   * @param ipAddress - Optional IP address
   */
  async logAccess(
    sessionId: string,
    serviceName: string,
    action: string,
    success: boolean,
    errorMessage?: string,
    ipAddress?: string
  ): Promise<void> {
    await this.db.prepare(`
      INSERT INTO telegram_session_access_logs (
        session_id, service_name, action, timestamp, 
        ip_address, success, error_message
      ) VALUES (
        ?, ?, ?, datetime('now'), 
        ?, ?, ?
      )
    `).bind(
      sessionId,
      serviceName,
      action,
      ipAddress || null,
      success ? 1 : 0,
      errorMessage || null
    ).run();
  }
  
  /**
   * Update the last used timestamp for a session
   * @param sessionId - The session ID
   */
  private async updateLastUsed(sessionId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE telegram_sessions
      SET last_used_at = datetime('now')
      WHERE id = ?
    `).bind(sessionId).run();
  }
  
  /**
   * Add a session to the memory cache
   * @param session - The session to cache
   */
  private addToCache(session: TelegramSession): void {
    const expiresAt = new Date(Date.now() + this.cacheTTL);
    this.memoryCache[session.id] = { session, expiresAt };
    
    // Clean up expired cache entries
    this.cleanCache();
  }
  
  /**
   * Get a session from the memory cache
   * @param sessionId - The session ID
   * @returns The session or undefined if not in cache
   */
  private getFromCache(sessionId: string): TelegramSession | undefined {
    const cached = this.memoryCache[sessionId];
    
    if (!cached) {
      return undefined;
    }
    
    // Check if cache entry has expired
    if (cached.expiresAt < new Date()) {
      delete this.memoryCache[sessionId];
      return undefined;
    }
    
    return cached.session;
  }
  
  /**
   * Clean expired entries from the memory cache
   */
  private cleanCache(): void {
    const now = new Date();
    
    for (const [sessionId, cached] of Object.entries(this.memoryCache)) {
      if (cached.expiresAt < now) {
        delete this.memoryCache[sessionId];
      }
    }
  }
  
  /**
   * Decrypt a session
   * @param session - The session to decrypt
   * @returns The decrypted session string
   */
  private async decryptSession(session: TelegramSession): Promise<string> {
    // Use the session ID as the salt
    const salt = session.id;
    
    // Decrypt the session data
    return decrypt(
      session.encryptedData,
      session.iv,
      this.sessionSecret,
      salt
    );
  }
}