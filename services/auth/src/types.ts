import * as jose from 'jose';
/**
 * Auth service types
 */
import { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { User } from './interfaces/auth-provider.interface'; // Use schema-inferred User type
import type { TokenPayload } from './interfaces/token-manager.interface'; // Use new TokenPayload

export { User, TokenPayload }; // Re-export for convenience

/**
 * User type with password, for internal use.
 */
export type UserWithPassword = User & {
  hashedPassword: string | null; // Or just string if it's always present for local accounts
};

/**
 * User role enum
 */
export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

// Removed User interface (lines 18-25 in original) - now imported
// Removed UserWithPassword interface (lines 30-32 in original) - to be handled by UserManager or specific db types
// Removed TokenPayload interface (lines 37-43 in original) - now imported

/**
 * Supported Authentication Providers
 */
export enum SupportedAuthProvider {
  LOCAL = 'local', // Renamed from EMAIL for clarity
  PRIVY = 'privy',
  GOOGLE = 'google',
  GITHUB = 'github',
  // Add other providers as needed
}

/**
 * Generic configuration for an authentication provider.
 * Specific providers might extend this or have their own detailed config types.
 */
export interface ProviderConfig {
  clientId?: string;
  clientSecret?: string; // Should be handled securely, e.g., via environment variables
  callbackUrl?: string;
  scopes?: string[];
  isEnabled: boolean;
  [key: string]: any; // For additional provider-specific settings
}

/**
 * Configuration map for all authentication providers.
 */
export type AuthProvidersConfig = {
  [key in SupportedAuthProvider]?: ProviderConfig;
};

/**
 * Login response
 */
export interface LoginResponse {
  success: boolean;
  user: User;
  token: string;
  tokenType: string; // e.g., 'bearer'
  expiresAt?: number; // Timestamp or ISO string
  expiresIn?: number; // Duration in seconds until token expiry
  provider: string;
}

/**
 * Registration response
 */
export interface RegisterResponse {
  success: boolean;
  user: User;
  token: string;
  tokenType: string; // e.g., 'bearer'
  expiresAt?: number; // Timestamp or ISO string
  provider: string;
}

/**
 * Token validation response
 */
export interface ValidateTokenResponse {
  success: boolean;
  userId: string;
  user?: User; // Add the user object to the response
  provider: SupportedAuthProvider;
  details?: any; // Additional details from the token or validation process
  ttl?: number; // Optional: Remaining time to live for the token in seconds
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
  x?: string; // X Coordinate
  y?: string; // Y Coordinate
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
