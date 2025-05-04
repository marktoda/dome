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
   * Login a user
   */
  login(email: string, password: string): Promise<LoginResponse>;

  /**
   * Register a new user
   */
  register(email: string, password: string, name?: string): Promise<RegisterResponse>;

  /**
   * Validate a token
   */
  validateToken(token: string): Promise<ValidateTokenResponse>;

  /**
   * Logout a user (invalidate their token)
   */
  logout(token: string): Promise<LogoutResponse>;
}

/**
 * Interface for the Auth client service
 * Mirrors the methods available via the binding
 */
export interface AuthService extends AuthBinding {}
