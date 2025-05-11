import * as jose from 'jose';
/**
 * Auth service types
 */
import { D1Database, KVNamespace } from '@cloudflare/workers-types';

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
  user: User | null; // User object if successful, null otherwise
  ttl?: number; // Remaining time to live for the token in seconds
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
 * Privy JWT claims
 */
export interface PrivyClaims extends jose.JWTPayload {
  // Standard claims
  iss: string; // Issuer (e.g., 'https://api.privy.io')
  sub: string; // Subject (Privy User ID - DID)
  aud: string | string[]; // Audience (Your Privy App ID)
  exp: number; // Expiration time
  nbf?: number; // Not before time
  iat: number; // Issued at time
  jti: string; // JWT ID

  // Privy-specific claims (refer to Privy docs for exhaustive list)
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
  name?: string;
  // Add other custom claims as needed
}

/**
 * JSON Web Key (JWK) structure
 */
export interface Jwk {
  kty: string; // Key Type (e.g., "EC")
  use?: string; // Public Key Use (e.g., "sig" for signature)
  kid?: string; // Key ID
  alg?: string; // Algorithm (e.g., "ES256")
  crv?: string; // Curve (e.g., "P-256")
  x?: string;   // X Coordinate
  y?: string;   // Y Coordinate
  // other properties as per RFC 7517
}

/**
 * JSON Web Key Set (JWKS) structure
 */
export interface Jwks {
  keys: Jwk[];
}

/**
 * Validate Privy Token Response
 */
export interface ValidatePrivyTokenResponse {
  success: boolean;
  user: User;
  jwksCacheTtlRemaining?: number;
}
