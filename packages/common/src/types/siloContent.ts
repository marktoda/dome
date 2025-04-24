/**
 * Silo Service Models
 *
 * This file contains the Zod schemas for validating input data for the Silo service.
 */

import { z } from 'zod';

// Content category enum (what the content represents)
export const ContentCategoryEnum = z.enum(['note', 'code', 'document', 'article', 'other']);
export type ContentCategory = z.infer<typeof ContentCategoryEnum>;

// Common MIME types (how to parse/render the content)
const CommonMimeTypeEnum = z.enum([
  'text/plain',
  'text/markdown',
  'text/html',
  'application/json',
  'application/javascript',
  'application/python',
  'application/pdf',
  'image/jpeg',
  'image/png',
  // Add other common MIME types as needed
]);

// Allow either common MIME types or custom string MIME types
export const MimeTypeSchema = z.union([CommonMimeTypeEnum, z.string()]);
export type MimeType = z.infer<typeof MimeTypeSchema>;

/**
 * Content metadata structure
 * Represents the metadata for content stored in Silo
 */
export interface SiloContentMetadata {
  id: string;
  userId: string | null;
  title?: string;
  summary?: string;
  category: ContentCategory;
  mimeType: MimeType;
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
  category: ContentCategory;
  mimeType: MimeType;
  size: number;
  createdAt: number;
  updatedAt?: number;

  // Content fields
  title?: string;
  summary?: string;
  body: string;

  // Additional metadata as a generic record
  metadata?: Record<string, any>;
}

/**
 * Schema for simplePut RPC method
 * Used to validate input for storing small content items synchronously
 */
export const siloSimplePutSchema = z.object({
  id: z.string().optional(),
  category: ContentCategoryEnum.default('note'),
  mimeType: MimeTypeSchema.default('text/markdown'),
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
 * Schema for batchGet RPC method
 * Used to validate input for retrieving multiple content items
 */
export const siloBatchGetSchema = z.object({
  ids: z.array(z.string()).optional().default([]),
  userId: z.string().nullable().optional(),
  category: z.string().optional(),
  mimeType: z.string().optional(),
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
export type SiloSimplePutInput = z.input<typeof siloSimplePutSchema>;

/**
 * SimplePut RPC method return type
 * Returned when a small content item is stored synchronously
 */
export interface SiloSimplePutResponse {
  /** Unique identifier for the content */
  id: string;
  /** Category of content (note, code, etc.) */
  category: ContentCategory;
  /** MIME type of the content */
  mimeType: MimeType;
  /** Size of the content in bytes */
  size: number;
  /** Unix timestamp (seconds) when the content was created */
  createdAt: number;
}

/**
 * BatchGet RPC method return type
 * Returned when retrieving multiple content items
 */
export interface SiloContentBatch {
  /** Array of content items */
  items: SiloContentItem[];
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
export interface SiloContentItem {
  /** Unique identifier for the content */
  id: string;
  /** User ID who owns the content, or null for public content */
  userId: string | null;
  /** Category of content (note, code, etc.) */
  category: ContentCategory;
  title?: string;
  summary?: string;
  /** MIME type of the content */
  mimeType: MimeType;
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
  /** Category of content (note, code, etc.) */
  category: ContentCategory;
  /** MIME type of the content */
  mimeType: MimeType;
  /** Size of the content in bytes */
  size: number;
  /** Unix timestamp (seconds) when the content was created */
  createdAt: number;
}
