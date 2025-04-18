import type { Context, MiddlewareHandler } from 'hono';
/**
 * User role enum
 */
export declare enum UserRole {
    USER = "user",
    ADMIN = "admin"
}
/**
 * User information interface
 */
export interface UserInfo {
    id: string;
    email?: string;
    role: UserRole;
    permissions?: string[];
}
/**
 * Enhanced authentication middleware options
 */
export interface EnhancedAuthOptions {
    /**
     * Header name for the authorization token
     * @default 'authorization'
     */
    authHeaderName?: string;
    /**
     * Header name for the user ID (for development)
     * @default 'x-user-id'
     */
    userIdHeaderName?: string;
    /**
     * Whether to skip authentication in development mode
     * @default true
     */
    skipInDevelopment?: boolean;
    /**
     * Required permissions for the route
     */
    requiredPermissions?: string[];
    /**
     * Required role for the route
     */
    requiredRole?: UserRole;
}
/**
 * Creates an enhanced authentication middleware that validates JWT tokens
 * and provides user information to the request context
 *
 * @param options Authentication options
 * @returns Middleware handler
 */
export declare function createEnhancedAuthMiddleware(options?: EnhancedAuthOptions): MiddlewareHandler;
/**
 * Helper function to get user info from context
 *
 * @param c Hono context
 * @returns User information
 */
export declare function getUserInfo(c: Context): UserInfo;
/**
 * Creates a middleware that requires specific permissions
 *
 * @param permissions Required permissions
 * @returns Middleware handler
 */
export declare function requirePermissions(permissions: string[]): MiddlewareHandler;
/**
 * Creates a middleware that requires a specific role
 *
 * @param role Required role
 * @returns Middleware handler
 */
export declare function requireRole(role: UserRole): MiddlewareHandler;
/**
 * Creates a middleware that ensures the user can only access their own resources
 *
 * @param paramName Parameter name that contains the resource owner ID
 * @returns Middleware handler
 */
export declare function requireOwnership(paramName?: string): MiddlewareHandler;
