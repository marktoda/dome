/**
 * Silo Service Models
 *
 * This file contains the Zod schemas for validating input data for the Silo service.
 */

import { z } from 'zod';

const ContentTypeEnum = z.enum(['note', 'code', 'text/plain']);
export type ContentType = z.infer<typeof ContentTypeEnum>;

/**
 * Content metadata structure
 * Represents the metadata for content stored in Silo
 */
export interface SiloContentMetadata {
  id: string;
  userId: string | null;
  contentType: ContentType;
  size: number;
  r2Key: string;
  sha256?: string;
  createdAt: number;
  version: number;
}

/**
 * Content structure
 * Represents a content item stored in Silo with its metadata and body
 */
export interface SiloContent {
  // Metadata fields
  id: string;
  userId: string | null;
  contentType: ContentType;
  size: number;
  createdAt: number;
  updatedAt?: number;

  // Content fields
  title?: string;
  body: string;

  // Additional metadata as a generic record
  metadata?: Record<string, any>;
}

/**
 * Embedding job structure
 * Represents a job to embed content into a vector
 */
export interface SiloEmbedJob {
  userId: string;
  contentId: string;
  text: string;
  created: number;
  version: number;
  contentType: ContentType;
}

/**
 * Schema for simplePut RPC method
 * Used to validate input for storing small content items synchronously
 */
export const siloSimplePutSchema = z.object({
  id: z.string().optional(),
  contentType: ContentTypeEnum.default('note'),
  content: z.union([z.string(), z.instanceof(ArrayBuffer)]).refine(
    val => {
      // Check if content is not empty
      if (typeof val === 'string') {
        return val.length > 0;
      }
      return val.byteLength > 0;
    },
    {
      message: 'Content cannot be empty',
    },
  ),
  userId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

/**
 * Schema for createUpload RPC method
 * Used to validate input for generating pre-signed forms for direct browser-to-R2 uploads
 */
export const siloCreateUploadSchema = z.object({
  contentType: ContentTypeEnum.default('note'),
  size: z.number().positive('Size must be a positive number'),
  metadata: z.record(z.string(), z.any()).optional(),
  expirationSeconds: z.number().min(60).max(3600).optional(), // Default 15 minutes, max 1 hour
  sha256: z.string().optional(),
  userId: z.string().optional(),
});

/**
 * Schema for batchGet RPC method
 * Used to validate input for retrieving multiple content items
 */
export const siloBatchGetSchema = z.object({
  ids: z.array(z.string()).optional().default([]),
  userId: z.string().nullable().optional(),
  contentType: z.string().optional(),
  limit: z.number().positive().optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

/**
 * Schema for delete RPC method
 * Used to validate input for deleting content items
 */
export const siloDeleteSchema = z.object({
  id: z.string(),
  userId: z.string().nullable().optional(),
});

/**
 * Schema for stats RPC method
 * Used to validate input for retrieving storage statistics
 */
export const siloStatsSchema = z.object({}).optional();

/**
 * Additional types inferred from the schemas
 */
export type SiloBatchGetInput = z.input<typeof siloBatchGetSchema>;
export type SiloDeleteInput = z.input<typeof siloDeleteSchema>;
export type SiloStatsInput = z.input<typeof siloStatsSchema>;
export type SiloCreateUploadInput = z.input<typeof siloCreateUploadSchema>;
export type SiloSimplePutInput = z.input<typeof siloSimplePutSchema>;

/**
 * SimplePut RPC method return type
 * Returned when a small content item is stored synchronously
 */
export interface SiloSimplePutResponse {
  /** Unique identifier for the content */
  id: string;
  /** Type of content (note, code, etc.) */
  contentType: ContentType;
  /** Size of the content in bytes */
  size: number;
  /** Unix timestamp (seconds) when the content was created */
  createdAt: number;
}

/**
 * CreateUpload RPC method return type
 * Returned when a pre-signed form for direct browser-to-R2 upload is generated
 */
export interface SiloCreateUploadResponse {
  /** Unique identifier for the content */
  id: string;
  /** URL to which the form should be submitted */
  uploadUrl: string;
  /** Form fields to include in the upload */
  formData: Record<string, string>;
  /** Number of seconds until the pre-signed URL expires */
  expiresIn: number;
}

/**
 * BatchGet RPC method return type
 * Returned when retrieving multiple content items
 */
export interface SiloBatchGetResponse {
  /** Array of content items */
  items: SiloBatchGetItem[];
  /** Total number of items matching the query (for pagination) */
  total?: number;
  /** Limit used for the query */
  limit?: number;
  /** Offset used for the query */
  offset?: number;
}

/**
 * Individual item in a BatchGet response
 */
export interface SiloBatchGetItem {
  /** Unique identifier for the content */
  id: string;
  /** User ID who owns the content, or null for public content */
  userId: string | null;
  /** Type of content (note, code, etc.) */
  contentType: ContentType;
  /** Size of the content in bytes */
  size: number;
  /** Unix timestamp (seconds) when the content was created */
  createdAt: number;
  /** Content body for small items (≤ 1MB), only included for small items */
  body?: string;
  /** Pre-signed URL for downloading large items (> 1MB), only included for large items */
  url?: string;
}

/**
 * Delete RPC method return type
 * Returned when a content item is deleted
 */
export interface SiloDeleteResponse {
  /** Whether the deletion was successful */
  success: boolean;
}

/**
 * Stats RPC method return type
 * Returned when retrieving storage statistics
 */
export interface SiloStatsResponse {
  /** Total number of content items */
  total: number;
  /** Total size of all content in bytes */
  totalSize: number;
  /** Count of content items by type */
  byType: Record<string, number>;
}

/**
 * R2 Event processing response
 * Returned when an R2 object-created event is processed
 */
export interface SiloProcessR2EventResponse {
  /** Unique identifier for the content */
  id: string;
  /** Type of content (note, code, etc.) */
  contentType: string;
  /** Size of the content in bytes */
  size: number;
  /** Unix timestamp (seconds) when the content was created */
  createdAt: number;
}
