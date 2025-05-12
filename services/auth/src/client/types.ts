/**
 * Type definitions for the Auth client
 */
import {
  User,
  UserRole,
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse,
  LogoutResponse,
} from '../types';

// Re-export types that are used by the client
export { User, UserRole, LoginResponse, RegisterResponse, ValidateTokenResponse, LogoutResponse };

/**
 * Error codes for auth operations
 */
export enum AuthErrorCode {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_EXISTS = 'USER_EXISTS',
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  MISSING_TOKEN = 'MISSING_TOKEN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  REGISTRATION_FAILED = 'REGISTRATION_FAILED',
  LOGIN_FAILED = 'LOGIN_FAILED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Interface for Auth service RPC binding
 * Matches the public methods exposed by the WorkerEntrypoint
 */
export interface AuthBinding {
  /**
   * Login a user with a specific provider.
   * @param providerName The name of the authentication provider (e.g., 'email', 'google').
   * @param credentials Provider-specific credentials.
   */
  login(providerName: string, credentials: Record<string, unknown>): Promise<LoginResponse>;

  /**
   * Register a new user with a specific provider.
   * @param providerName The name of the authentication provider.
   * @param registrationData Provider-specific registration data.
   */
  register(providerName: string, registrationData: Record<string, unknown>): Promise<RegisterResponse>;

  /**
   * Validate a token. Provider can be optionally specified.
   * @param token The token to validate.
   * @param providerName Optional: The name of the provider that issued the token.
   */
  validateToken(token: string, providerName?: string): Promise<ValidateTokenResponse>;

  /**
   * Logout a user (invalidate their token) with a specific provider.
   * @param providerName The name of the authentication provider.
   * @param token The token to invalidate.
   */
  logout(providerName: string, token: string): Promise<LogoutResponse>;
}

/**
 * Interface for the Auth client service
 * Mirrors the methods available via the binding
 */
export interface AuthService extends AuthBinding {}
