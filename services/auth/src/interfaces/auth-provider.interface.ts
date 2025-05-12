/**
 * @file Defines the core interface for authentication providers.
 * Each authentication provider (e.g., Google, GitHub, email/password)
 * must implement this interface.
 */

import { users } from '../db/schema'; // Assuming 'users' is the Drizzle table schema

// Infer User type from the schema
export type User = typeof users.$inferSelect;

/**
 * Represents the result of an authentication attempt.
 */
export interface AuthResult {
  /** Indicates if the authentication was successful. */
  success: boolean;
  /** The authenticated user, if successful. */
  user?: User;
  /** An error message, if authentication failed. */
  error?: string;
  /** Optional: External provider's access token, if applicable. */
  providerAccessToken?: string;
  /** Optional: External provider's refresh token, if applicable. */
  providerRefreshToken?: string;
}

/**
 * Interface for an authentication provider.
 */
export interface AuthProvider {
  /**
   * The unique name of the provider (e.g., 'google', 'email').
   */
  readonly providerName: string;

  /**
   * Authenticates a user based on provider-specific credentials or tokens.
   * @param credentials - An object containing credentials or tokens required by the provider.
   *                      This could be an email/password pair, an OAuth code, an ID token, etc.
   * @returns A promise that resolves to an AuthResult.
   */
  authenticate(credentials: unknown): Promise<AuthResult>;

  /**
   * Optional: Handles the callback from an OAuth provider.
   * @param callbackParams - Parameters received from the OAuth provider's redirect.
   * @returns A promise that resolves to an AuthResult.
   */
  handleCallback?(callbackParams: unknown): Promise<AuthResult>;

  /**
   * Optional: Refreshes an access token using a refresh token, if supported by the provider.
   * @param refreshToken - The refresh token.
   * @returns A promise that resolves to an object containing the new access token and optionally a new refresh token.
   */
  refreshAccessToken?(refreshToken: string): Promise<{
    accessToken: string;
    newRefreshToken?: string;
    expiresIn?: number;
  }>;

  /**
   * Optional: Retrieves user information from the provider using an access token.
   * @param accessToken - The provider's access token.
   * @returns A promise that resolves to the user's information from the provider.
   */
  getUserInfo?(accessToken: string): Promise<Partial<User> | null>;
}