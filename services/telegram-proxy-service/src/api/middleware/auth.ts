import { Request, Response, NextFunction } from 'express';
import * as jsonwebtoken from 'jsonwebtoken';
const jwt = jsonwebtoken as any;
import { verifyToken, extractTokenFromHeader, JwtPayload, generateToken } from '../../utils/security';
import { AuthenticationError, AuthorizationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { AUTH } from '../../config';

/**
 * Extended Request interface with authentication properties
 */
export interface AuthenticatedRequest extends Request {
  sessionId?: string;
  userId?: string;
  role?: string;
}

/**
 * Authentication middleware
 * Verifies JWT tokens and attaches session information to the request
 */
export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization;
    const token = extractTokenFromHeader(authHeader);
    const payload = verifyToken(token);
    
    // Attach session ID and user ID to request
    const authReq = req as AuthenticatedRequest;
    authReq.sessionId = payload.sessionId;
    authReq.userId = payload.userId;
    authReq.role = payload.role;
    
    next();
  } catch (error) {
    next(new AuthenticationError(error instanceof Error ? error.message : 'Authentication failed'));
  }
};

/**
 * Role-based access control middleware
 * Ensures the authenticated user has the required role
 * 
 * @param requiredRoles Array of roles that are allowed to access the route
 */
export const authorize = (requiredRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const authReq = req as AuthenticatedRequest;
      
      // Check if user has a role
      if (!authReq.role) {
        throw new AuthorizationError('Role information missing');
      }
      
      // Check if user's role is in the required roles
      if (!requiredRoles.includes(authReq.role)) {
        throw new AuthorizationError(`Required role: ${requiredRoles.join(' or ')}`);
      }
      
      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * API key authentication middleware
 * Verifies API keys for service-to-service communication
 */
export const authenticateApiKey = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    
    if (!apiKey) {
      throw new AuthenticationError('API key is required');
    }
    
    // In a real implementation, you would validate the API key against a database
    // For now, we'll use a simple check against environment variables
    const validApiKeys = (process.env.VALID_API_KEYS || '').split(',').filter(Boolean);
    
    if (!validApiKeys.includes(apiKey)) {
      throw new AuthenticationError('Invalid API key');
    }
    
    // For API key auth, we don't have a session ID or user ID
    // Instead, we'll set a service identifier
    (req as AuthenticatedRequest).role = 'service';
    
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Generate a JWT token for a session
 * 
 * @param sessionId The session ID
 * @param userId The user ID
 * @param role The user role (optional)
 * @returns A JWT token
 */
export function generateAuthToken(sessionId: string, userId: string, role?: string): string {
  const payload: JwtPayload = {
    sessionId,
    userId,
    role
  };
  
  return generateToken(payload);
}

/**
 * Generate a refresh token for a session
 * 
 * @param sessionId The session ID
 * @param userId The user ID
 * @returns A refresh token
 */
export function generateRefreshToken(sessionId: string, userId: string): string {
  const payload: JwtPayload = {
    sessionId,
    userId,
    // No role for refresh tokens
  };
  
  // Refresh tokens have a longer expiration
  return jwt.sign(payload, AUTH.JWT_SECRET, {
    expiresIn: '7d', // 7 days
  });
}

/**
 * Verify a refresh token
 * 
 * @param token The refresh token
 * @returns The decoded payload
 */
export function verifyRefreshToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, AUTH.JWT_SECRET) as JwtPayload;
  } catch (error) {
    throw new AuthenticationError('Invalid or expired refresh token');
  }
}