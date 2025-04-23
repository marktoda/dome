/**
 * Metadata Types
 *
 * This file defines types related to content metadata headers that are
 * injected into content by the tsunami service. These types are internal
 * to the tsunami service and not exposed to other services.
 *
 * @module types/metadata
 */

/**
 * Source metadata information
 * Contains details about where the content originated from
 */
export interface SourceMetadata {
  /** The type of source (e.g., 'github') */
  type: string;
  /** The repository identifier (owner/repo) */
  repository: string;
  /** The file path within the repository */
  path: string;
  /** The timestamp when the content was last updated */
  updated_at: string;
}

/**
 * Content metadata information
 * Contains details about the content itself
 */
export interface ContentMetadata {
  /** The type of content (e.g., 'code') */
  type: string;
  /** The programming language of the content */
  language: string;
  /** The size of the content in bytes */
  size_bytes: number;
}

/**
 * Ingestion metadata information
 * Contains details about the ingestion process
 */
export interface IngestionMetadata {
  /** The timestamp when the content was ingested */
  timestamp: string;
  /** The version of the metadata format */
  version: string;
}

/**
 * Complete metadata structure
 * Contains all metadata sections
 */
export interface DomeMetadata {
  /** Source information */
  source: SourceMetadata;
  /** Content information */
  content: ContentMetadata;
  /** Ingestion information */
  ingestion: IngestionMetadata;
}