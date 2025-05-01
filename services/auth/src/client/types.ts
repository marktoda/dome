import { z } from 'zod';
import { UserRole } from '../types';

/**
 * Auth client types
 */

/**
 * User interface for the client
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
 * Login response interface
 */
export interface LoginResponse {
  success: boolean;
  user: User;
  token: string;
  expiresIn: number;
}

/**
 * Login request schema
 */
export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

/**
 * Register request schema
 */
export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

/**
 * Authentication service interface for service-to-service communication
 */
export interface AuthServiceInterface {
  login(email: string, password: string): Promise<LoginResponse>;
  register(email: string, password: string, name?: string): Promise<{ success: boolean; user: User }>;
  validateToken(token: string): Promise<{ success: boolean; user: User }>;
  logout(token: string): Promise<{ success: boolean }>;
}