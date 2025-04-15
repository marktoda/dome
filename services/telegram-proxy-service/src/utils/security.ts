import * as jsonwebtoken from 'jsonwebtoken';
const jwt = jsonwebtoken as any;
import crypto from 'crypto';
import { AUTH } from '../config';
import { AuthenticationError } from './errors';

/**
 * Interface for JWT payload
 */
export interface JwtPayload {
  sessionId: string;
  userId?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

/**
 * Generate a JWT token for a session
 */
export function generateToken(payload: JwtPayload): string {
  if (!AUTH.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined');
  }
  return jwt.sign(
    payload,
    Buffer.from(AUTH.JWT_SECRET, 'utf-8'),
    {
      expiresIn: AUTH.JWT_EXPIRATION,
    }
  );
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, AUTH.JWT_SECRET) as JwtPayload;
  } catch (error) {
    throw new AuthenticationError('Invalid or expired token');
  }
}

/**
 * Extract token from authorization header
 */
export function extractTokenFromHeader(authHeader?: string): string {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthenticationError('No token provided');
  }
  
  return authHeader.split(' ')[1];
}

/**
 * Generate a random string for use as a session ID
 */
export function generateRandomId(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Create an HMAC signature for request signing
 */
export function createSignature(data: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('hex');
}

/**
 * Verify a request signature
 */
export function verifySignature(
  signature: string,
  data: string,
  secret: string
): boolean {
  const expectedSignature = createSignature(data, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Generate a secure random string for use as a secret key
 */
export function generateSecretKey(length = 64): string {
  return crypto.randomBytes(length).toString('base64');
}

/**
 * Hash a string using SHA-256
 */
export function hashString(data: string): string {
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex');
}