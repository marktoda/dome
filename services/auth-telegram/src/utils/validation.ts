/**
 * Validation utilities
 */
import { z } from 'zod';

/**
 * Phone number validation schema
 */
export const phoneNumberSchema = z
  .string()
  .min(6, 'Phone number must be at least 6 characters')
  .max(15, 'Phone number must be at most 15 characters')
  .regex(/^\+?[0-9]+$/, 'Phone number must contain only digits and optionally start with +');

/**
 * Authentication code validation schema
 */
export const authCodeSchema = z
  .string()
  .min(1, 'Authentication code is required')
  .max(10, 'Authentication code must be at most 10 characters')
  .regex(/^[0-9]+$/, 'Authentication code must contain only digits');

/**
 * Phone code hash validation schema
 */
export const phoneCodeHashSchema = z.string().min(1, 'Phone code hash is required');

/**
 * Session ID validation schema
 */
export const sessionIdSchema = z.string().min(1, 'Session ID is required');

/**
 * User ID validation schema
 */
export const userIdSchema = z
  .number()
  .int('User ID must be an integer')
  .positive('User ID must be positive');

/**
 * API key validation schema
 */
export const apiKeySchema = z.string().min(16, 'API key must be at least 16 characters');

/**
 * Service ID validation schema
 */
export const serviceIdSchema = z.string().min(1, 'Service ID is required');

/**
 * Send code request schema
 */
export const sendCodeRequestSchema = z.object({
  phoneNumber: phoneNumberSchema,
});

/**
 * Verify code request schema
 */
export const verifyCodeRequestSchema = z.object({
  phoneNumber: phoneNumberSchema,
  phoneCodeHash: phoneCodeHashSchema,
  code: authCodeSchema,
});

/**
 * Get session request schema
 */
export const getSessionRequestSchema = z.object({
  userId: userIdSchema,
});

/**
 * Revoke session request schema
 */
export const revokeSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
});

/**
 * Service authentication schema
 */
export const serviceAuthSchema = z.object({
  apiKey: apiKeySchema,
  serviceId: serviceIdSchema,
});

/**
 * Type definitions for request schemas
 */
export type SendCodeRequest = z.infer<typeof sendCodeRequestSchema>;
export type VerifyCodeRequest = z.infer<typeof verifyCodeRequestSchema>;
export type GetSessionRequest = z.infer<typeof getSessionRequestSchema>;
export type RevokeSessionRequest = z.infer<typeof revokeSessionRequestSchema>;
export type ServiceAuth = z.infer<typeof serviceAuthSchema>;
