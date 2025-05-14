/**
 * @file Defines the interface for managing authentication tokens (e.g., JWTs).
 */

import { User } from './auth-provider.interface'; // Re-using the User type

/**
 * Represents the payload of an authentication token.
 */
export interface TokenPayload {
  /** User ID. */
  sub: string;
  /** User email. */
  email: string;
  /** Role associated with the user. */
  role?: string;
  /** Any other custom claims. */
  [key: string]: any;
}

/**
 * Represents a generated token.
 */
export interface GeneratedToken {
  /** The access token string. */
  accessToken: string;
  /** The refresh token string, if applicable. */
  refreshToken?: string;
  /** Expiration time of the access token in seconds. */
  expiresIn: number;
}

/**
 * Represents the result of token validation.
 */
export interface DecodedToken {
  /** The decoded payload of the token. */
  payload: TokenPayload;
  /** Indicates if the token is valid. */
  isValid: boolean;
  /** An error message, if validation failed. */
  error?: string;
}

/**
 * Interface for a token manager.
 */
export interface TokenManager {
  /**
   * Creates an access token and optionally a refresh token for a user.
   * @param user - The user object for whom to create the token.
   * @returns A promise that resolves to the generated token(s).
   */
  createTokens(user: Pick<User, 'id' | 'email' | 'role'>): Promise<GeneratedToken>;

  /**
   * Validates an access token.
   * @param token - The access token string to validate.
   * @returns A promise that resolves to the decoded token information.
   */
  validateAccessToken(token: string): Promise<DecodedToken>;

  /**
   * Refreshes an access token using a refresh token.
   * @param refreshToken - The refresh token string.
   * @returns A promise that resolves to a new set of tokens or an error.
   */
  refreshTokens(refreshToken: string): Promise<GeneratedToken | { error: string }>;

  /**
   * Optional: Invalidates a refresh token (e.g., during logout).
   * @param refreshToken - The refresh token to invalidate.
   * @returns A promise that resolves when the token is invalidated.
   */
  invalidateRefreshToken?(refreshToken: string): Promise<void>;

  /**
   * Optional: Decodes a token without verifying its signature (e.g., for debugging or quick inspection).
   * Use with caution, and do not trust the payload for security-sensitive operations without validation.
   * @param token - The token string to decode.
   * @returns The decoded payload or null if decoding fails.
   */
  decodeToken?(token: string): TokenPayload | null;
}
