/**
 * Silo Service Return Types
 *
 * This file contains type definitions for the return values of Silo service RPC methods.
 */

import { ContentCategory, MimeType } from './siloContent';

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
}

/**
 * Individual item in a BatchGet response
 */
export interface SiloBatchGetItem {
  /** Unique identifier for the content */
  id: string;
  /** User ID who owns the content, or null for public content */
  userId: string | null;
  /** Category of content (note, code, etc.) */
  category: ContentCategory;
  /** MIME type of the content */
  mimeType: MimeType;
  /** Size of the content in bytes */
  size: number;
  /** Unix timestamp (seconds) when the content was created */
  createdAt: number;
  /** AI-generated title for the content */
  title?: string;
  /** AI-generated summary of the content */
  summary?: string;
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

// Aliases for backward compatibility
export type SimplePutResponse = SiloSimplePutResponse;
export type CreateUploadResponse = SiloCreateUploadResponse;
export type BatchGetResponse = SiloBatchGetResponse;
export type BatchGetItem = SiloBatchGetItem;
export type DeleteResponse = SiloDeleteResponse;
export type StatsResponse = SiloStatsResponse;
export type ProcessR2EventResponse = SiloProcessR2EventResponse;
