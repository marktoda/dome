/**
 * Common ingestion contract for all content providers
 * This defines the interface that all ingestors must implement
 */

/**
 * Metadata for a content item
 */
export interface ItemMetadata {
  id: string;
  path: string;
  sha: string;
  size: number;
  mimeType: string;
  provider: string;
  repoId: string;
  userId: string | null;
  [key: string]: any; // Additional provider-specific metadata
}

/**
 * Content item with metadata and content access
 */
export interface ContentItem {
  metadata: ItemMetadata;
  getContent(): Promise<ReadableStream | string>;
}

/**
 * Configuration for an ingestor
 */
export interface IngestorConfig {
  id: string;
  userId: string | null;
  provider: string;
  [key: string]: any; // Provider-specific configuration
}

/**
 * Common interface for all content ingestors
 */
export interface Ingestor {
  /**
   * Get configuration for this ingestor
   */
  getConfig(): IngestorConfig;
  
  /**
   * List all items that need to be ingested
   */
  listItems(): Promise<ItemMetadata[]>;
  
  /**
   * Get content for a specific item
   * @param metadata Item metadata
   */
  fetchContent(metadata: ItemMetadata): Promise<ContentItem>;
  
  /**
   * Check if an item has changed since last sync
   * @param metadata Item metadata
   */
  hasChanged(metadata: ItemMetadata): Promise<boolean>;
  
  /**
   * Update sync status after successful ingestion
   * @param metadata Item metadata
   */
  updateSyncStatus(metadata: ItemMetadata): Promise<void>;
}

/**
 * Base class for ingestors with common functionality
 */
export abstract class BaseIngestor implements Ingestor {
  protected config: IngestorConfig;

  constructor(config: IngestorConfig) {
    this.config = config;
  }

  /**
   * Get configuration for this ingestor
   */
  getConfig(): IngestorConfig {
    return this.config;
  }

  /**
   * List all items that need to be ingested
   * Must be implemented by subclasses
   */
  abstract listItems(): Promise<ItemMetadata[]>;

  /**
   * Get content for a specific item
   * Must be implemented by subclasses
   * @param metadata Item metadata
   */
  abstract fetchContent(metadata: ItemMetadata): Promise<ContentItem>;

  /**
   * Check if an item has changed since last sync
   * Default implementation compares SHA hashes
   * @param metadata Item metadata
   */
  async hasChanged(metadata: ItemMetadata): Promise<boolean> {
    // Default implementation - subclasses should override with more efficient checks
    return true;
  }

  /**
   * Update sync status after successful ingestion
   * Must be implemented by subclasses
   * @param metadata Item metadata
   */
  abstract updateSyncStatus(metadata: ItemMetadata): Promise<void>;
}