import { getLogger } from '@dome/common';
import { DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import * as jose from 'jose';
import { User, UserRole, UserWithPassword, TokenPayload, LoginResponse, ValidateTokenResponse } from '../types';
import { users, tokenBlacklist } from '../db/schema';
import { AuthError, AuthErrorType } from '../utils/errors';

/**
 * Authentication Service
 * Handles user authentication, registration, and token management
 */
export class AuthService {
  private db: DrizzleD1Database;
  private kv: KVNamespace;
  private logger = getLogger().child({ component: 'AuthService' });
  private jwtSecret: Uint8Array;

  // Default token expiration: 24 hours
  private tokenExpiration = 24 * 60 * 60;

  /**
   * Create a new auth service instance
   */
  constructor(env: Env) {
    this.db = drizzle(env.AUTH_DB);
    this.kv = env.AUTH_TOKENS;

    // In production, we'd use a proper secret from KV or environment variable
    // For now, we'll use a static secret for development
    const secretKey = 'dome-auth-secret-key-change-in-production';
    this.jwtSecret = new TextEncoder().encode(secretKey);
  }

  /**
   * Register a new user
   */
  async register(email: string, password: string, name?: string): Promise<User> {
    this.logger.debug({ email }, 'Registering new user');

    try {
      // Check if user already exists
      const existingUser = await this.db.select().from(users).where(eq(users.email, email)).get();

      if (existingUser) {
        throw new AuthError('User with this email already exists', AuthErrorType.USER_EXISTS);
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create the user record
      const timestamp = new Date();
      const userId = uuidv4();

      const newUser = {
        id: userId,
        email,
        password: hashedPassword,
        name: name || null,
        role: UserRole.USER,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      // Insert the user
      await this.db.insert(users).values(newUser);

      // Return user without password
      const { password: _, ...userWithoutPassword } = newUser;
      return userWithoutPassword as User;
    } catch (error) {
      this.logger.error({ error, email }, 'Failed to register user');

      if (error instanceof AuthError) {
        throw error;
      }

      throw new AuthError('Failed to register user', AuthErrorType.REGISTRATION_FAILED);
    }
  }

  /**
   * Login a user
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    this.logger.debug({ email }, 'User login attempt');

    try {
      // Find the user
      const user = (await this.db.select().from(users).where(eq(users.email, email)).get()) as
        | UserWithPassword
        | undefined;

      if (!user) {
        throw new AuthError('Invalid email or password', AuthErrorType.INVALID_CREDENTIALS);
      }

      // Check password
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        throw new AuthError('Invalid email or password', AuthErrorType.INVALID_CREDENTIALS);
      }

      // Generate token
      const token = await this.generateToken(user);

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;

      return {
        success: true,
        user: userWithoutPassword as User,
        token,
        expiresIn: this.tokenExpiration,
      };
    } catch (error) {
      this.logger.error({ error, email }, 'Login failed');

      if (error instanceof AuthError) {
        throw error;
      }

      throw new AuthError('Login failed', AuthErrorType.LOGIN_FAILED);
    }
  }

  /**
   * Validate a token and return the user
   */
  async validateToken(token: string): Promise<ValidateTokenResponse> {
    this.logger.debug('Validating auth token');

    try {
      // Defensively remove "Bearer " prefix if present
      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
      this.logger.debug({ originalToken: token, cleanedToken: cleanToken }, 'Cleaning token for validation');

      // Check if token is blacklisted (use the cleaned token for this check)
      const blacklisted = await this.isTokenBlacklisted(cleanToken);

      if (blacklisted) {
        this.logger.warn({ token: cleanToken }, 'Token is blacklisted'); // Log the token that was checked
        return { success: false, user: null };
      }

      // Verify the token (use the cleaned token)
      this.logger.debug({ tokenFromValidateMethod: cleanToken }, 'AUTH SERVICE: Token being verified'); // DEBUG LOG (now logs cleaned token)
      const { payload } = await jose.jwtVerify(cleanToken, this.jwtSecret);
      const tokenPayload = payload as unknown as TokenPayload;

      // Get the user
      const user = await this.getUserById(tokenPayload.userId);

      if (!user) {
        this.logger.warn({ userId: tokenPayload.userId }, 'User not found for token');
        return { success: false, user: null };
      }

      const now = Math.floor(Date.now() / 1000);
      const ttl = tokenPayload.exp ? tokenPayload.exp - now : undefined;

      if (ttl !== undefined && ttl <= 0) {
        this.logger.warn({ userId: user.id, exp: tokenPayload.exp }, 'Token expired');
        return { success: false, user: null, ttl: 0 };
      }

      this.logger.debug({ userId: user.id, ttl }, 'Token validated successfully');
      return { success: true, user, ttl };
    } catch (error) {
      this.logger.error({ error }, 'Token validation failed');
      // Distinguish between verification errors (expired, invalid signature) and other errors
      if (error instanceof jose.errors.JWTExpired) {
        return { success: false, user: null, ttl: 0 };
      }
      if (error instanceof jose.errors.JOSEError) { // Covers other JOSE errors like signature invalid
        return { success: false, user: null };
      }
      // For AuthErrors or other unexpected errors, rethrow or handle as appropriate
      // For simplicity here, we'll return a generic failure.
      // In a real app, you might want to log more specifically or rethrow certain errors.
      return { success: false, user: null };
    }
  }

  /**
   * Logout a user by blacklisting their token
   */
  async logout(token: string, userId: string): Promise<boolean> {
    this.logger.debug({ userId }, 'Logging out user');

    try {
      // Defensively remove "Bearer " prefix if present, similar to validateToken
      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
      this.logger.debug({ originalToken: token, cleanedToken: cleanToken }, 'Cleaning token for logout');

      // Verify the cleaned token
      const { payload } = await jose.jwtVerify(cleanToken, this.jwtSecret);
      const tokenPayload = payload as unknown as TokenPayload;

      // Security check: Ensure the userId from the token matches the userId parameter
      // This prevents misuse if the caller provides an inconsistent userId.
      if (tokenPayload.userId !== userId) {
        this.logger.error(
          { tokenUserId: tokenPayload.userId, paramUserId: userId },
          'User ID in token does not match user ID in logout parameter.',
        );
        throw new AuthError('User ID mismatch during logout', AuthErrorType.INVALID_TOKEN);
      }

      const now = new Date();
      // Ensure tokenPayload.exp is a number (seconds since epoch)
      if (typeof tokenPayload.exp !== 'number') {
        this.logger.error({ payloadExp: tokenPayload.exp }, 'Invalid expiration time in token payload.');
        throw new AuthError('Invalid token expiration', AuthErrorType.INVALID_TOKEN);
      }
      const expiresAt = new Date(tokenPayload.exp * 1000);

      // Blacklist the cleaned token for consistency with validateToken's blacklist check
      // The `isTokenBlacklisted` method (called by `validateToken`) checks against the cleaned token.
      await this.db.insert(tokenBlacklist).values({
        token: cleanToken, // Use the cleaned token
        expiresAt,
        revokedAt: now,
        userId, // userId from parameter, now verified against token's userId
      });

      return true;
    } catch (error) {
      this.logger.error({ error, userId }, 'Logout failed');
      return false;
    }
  }

  /**
   * Get a user by ID
   */
  async getUserById(userId: string): Promise<User | null> {
    this.logger.debug({ userId }, 'Getting user by ID');

    try {
      const user = await this.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .get();

      return user as User | null;
    } catch (error) {
      this.logger.error({ error, userId }, 'Failed to get user');
      return null;
    }
  }

  /**
   * Generate a JWT token for a user
   */
  private async generateToken(user: UserWithPassword): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    const payload: TokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      iat: now,
      exp: now + this.tokenExpiration,
    };

    // Sign the token
    return await new jose.SignJWT(payload as unknown as jose.JWTPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .sign(this.jwtSecret);
  }

  /**
   * Check if a token is blacklisted
   */
  private async isTokenBlacklisted(token: string): Promise<boolean> {
    const blacklisted = await this.db
      .select()
      .from(tokenBlacklist)
      // isTokenBlacklisted receives a token string. It should check against this exact string.
      // If called from validateToken, `token` here will be `cleanToken`.
      // If called from elsewhere with a prefixed token, it would check that.
      .where(eq(tokenBlacklist.token, token))
      .get();

    return !!blacklisted;
  }
}

/**
 * Create a new auth service instance
 */
export function createAuthService(env: Env): AuthService {
  return new AuthService(env);
}
