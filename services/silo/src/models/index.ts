/**
 * Silo Service Models
 * 
 * This file contains the Zod schemas for validating input data for the Silo service.
 */

import { z } from 'zod';

/**
 * Schema for simplePut RPC method
 * Used to validate input for storing small content items synchronously
 */
export const simplePutSchema = z.object({
  id: z.string().optional(),
  contentType: z.string().default('note'),
  content: z.union([z.string(), z.instanceof(ArrayBuffer)]).refine(val => {
    // Check if content is not empty
    if (typeof val === 'string') {
      return val.length > 0;
    }
    return val.byteLength > 0;
  }, {
    message: 'Content cannot be empty'
  }),
  userId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  acl: z.object({
    public: z.boolean().optional().default(false)
  }).optional().default({})
});

/**
 * Schema for createUpload RPC method
 * Used to validate input for generating pre-signed forms for direct browser-to-R2 uploads
 */
export const createUploadSchema = z.object({
  contentType: z.string().default('note'),
  size: z.number().positive('Size must be a positive number'),
  metadata: z.record(z.string(), z.any()).optional(),
  acl: z.object({
    public: z.boolean().optional().default(false)
  }).optional().default({}),
  expirationSeconds: z.number().min(60).max(3600).optional().default(900), // Default 15 minutes, max 1 hour
  sha256: z.string().optional(),
  userId: z.string().optional()
});

/**
 * Types inferred from the schemas
 */
export type SimplePutInput = z.infer<typeof simplePutSchema>;
export type CreateUploadInput = z.infer<typeof createUploadSchema>;