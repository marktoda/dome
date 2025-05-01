/**
 * Auth service types for the UI
 */

/**
 * User role enum
 */
export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

/**
 * User interface for authenticated users
 */
export interface User {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Auth token payload
 */
export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  exp: number;
  iat: number;
}

/**
 * Login response
 */
export interface LoginResponse {
  success: boolean;
  user: User;
  token: string;
  expiresIn: number;
}

/**
 * Registration response
 */
export interface RegisterResponse {
  success: boolean;
  user: User;
}

/**
 * Token validation response
 */
export interface ValidateTokenResponse {
  success: boolean;
  user: User;
}

/**
 * Logout response
 */
export interface LogoutResponse {
  success: boolean;
}

/**
 * Context type with the authenticated user
 */
export interface AuthContext {
  user: User;
}

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
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}