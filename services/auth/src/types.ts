/**
 * Auth service types
 */
import { D1Database, KVNamespace } from '@cloudflare/workers-types';

/**
 * Environment bindings for the Auth service
 */
export type Bindings = {
  AUTH_DB: D1Database;
  AUTH_TOKENS: KVNamespace;
  VERSION?: string;
  ENVIRONMENT?: string;
};

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
 * Internal user record with password
 */
export interface UserWithPassword extends User {
  password: string;
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
  user: User;
  token: string;
  expiresIn: number;
}

/**
 * Context type with the authenticated user
 */
export interface AuthContext {
  user: User;
}