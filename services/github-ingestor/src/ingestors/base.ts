/**
 * Base Ingestor Interface
 * 
 * This file defines the common interface for all content ingestors.
 * It provides a standardized contract that all ingestors (GitHub, Notion, Linear, etc.)
 * must implement, ensuring consistent behavior and extensibility.
 */

import { getLogger } from '@dome/logging';
import { metrics } from '../utils/metrics';

/**
 * Content metadata common across all providers
 */
export interface ContentMetadata {
  id: string;
  title: string;
  url: string;
  provider: string;
  providerType: string;
  owner: string;
  repository?: string;
  path?: string;
  createdAt: Date;
  updatedAt: Date;
  size: number;
  contentType: string;
  language?: string;
  authors?: string[];
  tags?: string[];
  [key: string]: any; // Allow provider-specific metadata
}

/**
 * Alias for ContentMetadata for backward compatibility
 */
export type ItemMetadata = ContentMetadata;

/**
 * Content item with metadata and actual content
 */
export interface ContentItem {
  metadata: ContentMetadata;
  content: string;
  embedding?: number[];
}

/**
 * Ingestion options common across all providers
 */
export interface IngestionOptions {
  userId?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  maxSize?: number;
  maxItems?: number;
  recursive?: boolean;
  includeArchived?: boolean;
  [key: string]: any; // Allow provider-specific options
}

/**
 * Ingestion result
 */
export interface IngestionResult {
  success: boolean;
  itemsProcessed: number;
  itemsIngested: number;
  itemsSkipped: number;
  itemsFailed: number;
  totalSize: number;
  errors: Error[];
  warnings: string[];
  duration: number;
}

/**
 * Base ingestor interface that all provider-specific ingestors must implement
 */
export interface Ingestor {
  /**
   * Get the provider name
   */
  getProviderName(): string;
  
  /**
   * Get the provider type
   */
  getProviderType(): string;
  
  /**
   * Initialize the ingestor with environment and options
   */
  initialize(env: any, options?: any): Promise<void>;
  
  /**
   * Test the connection to the provider
   */
  testConnection(): Promise<boolean>;
  
  /**
   * Ingest content from the provider
   */
  ingest(options: IngestionOptions): Promise<IngestionResult>;
  
  /**
   * Ingest a specific item from the provider
   */
  ingestItem(itemId: string, options?: IngestionOptions): Promise<ContentItem | null>;
  
  /**
   * List available items from the provider
   */
  listItems(options?: IngestionOptions): Promise<ContentMetadata[]>;
  
  /**
   * Check if an item has changed since last ingestion
   */
  hasChanged(metadata: ContentMetadata): Promise<boolean>;
  
  /**
   * Fetch content for an item
   */
  fetchContent(metadata: ContentMetadata): Promise<ContentItem>;
  
  /**
   * Update sync status after successful ingestion
   */
  updateSyncStatus(metadata: ContentMetadata): Promise<void>;
}

/**
 * Base ingestor implementation with common functionality
 */
export abstract class BaseIngestor implements Ingestor {
  protected env: any;
  protected options: any;
  
  /**
   * Create a new ingestor
   */
  constructor() {
    this.env = {};
    this.options = {};
  }
  
  /**
   * Get the provider name
   */
  abstract getProviderName(): string;
  
  /**
   * Get the provider type
   */
  abstract getProviderType(): string;
  
  /**
   * Initialize the ingestor with environment and options
   */
  async initialize(env: any, options?: any): Promise<void> {
    this.env = env;
    this.options = options || {};
    
    getLogger().info(
      { provider: this.getProviderName(), type: this.getProviderType() },
      'Initializing ingestor'
    );
  }
  
  /**
   * Test the connection to the provider
   */
  abstract testConnection(): Promise<boolean>;
  
  /**
   * Ingest content from the provider
   */
  abstract ingest(options: IngestionOptions): Promise<IngestionResult>;
  
  /**
   * Ingest a specific item from the provider
   */
  abstract ingestItem(itemId: string, options?: IngestionOptions): Promise<ContentItem | null>;
  
  /**
   * List available items from the provider
   */
  abstract listItems(options?: IngestionOptions): Promise<ContentMetadata[]>;
  
  /**
   * Check if an item has changed since last ingestion
   */
  abstract hasChanged(metadata: ContentMetadata): Promise<boolean>;
  
  /**
   * Fetch content for an item
   */
  abstract fetchContent(metadata: ContentMetadata): Promise<ContentItem>;
  
  /**
   * Update sync status after successful ingestion
   */
  abstract updateSyncStatus(metadata: ContentMetadata): Promise<void>;
  
  /**
   * Track ingestion metrics
   */
  protected trackIngestionMetrics(result: IngestionResult, options: IngestionOptions): void {
    const tags = {
      provider: this.getProviderName(),
      type: this.getProviderType(),
      user_id: options.userId || 'anonymous',
      success: result.success.toString(),
    };
    
    metrics.counter('ingestion.items_processed', result.itemsProcessed, tags);
    metrics.counter('ingestion.items_ingested', result.itemsIngested, tags);
    metrics.counter('ingestion.items_skipped', result.itemsSkipped, tags);
    metrics.counter('ingestion.items_failed', result.itemsFailed, tags);
    metrics.counter('ingestion.bytes_processed', result.totalSize, tags);
    metrics.timing('ingestion.duration_ms', result.duration, tags);
    
    if (result.errors.length > 0) {
      metrics.counter('ingestion.errors', result.errors.length, tags);
    }
    
    if (result.warnings.length > 0) {
      metrics.counter('ingestion.warnings', result.warnings.length, tags);
    }
  }
  
  /**
   * Create a default ingestion result
   */
  protected createDefaultResult(): IngestionResult {
    return {
      success: true,
      itemsProcessed: 0,
      itemsIngested: 0,
      itemsSkipped: 0,
      itemsFailed: 0,
      totalSize: 0,
      errors: [],
      warnings: [],
      duration: 0,
    };
  }
  
  /**
   * Check if a path matches include/exclude patterns
   */
  protected shouldIncludePath(path: string, options: IngestionOptions): boolean {
    // If no patterns are specified, include everything
    if (!options.includePatterns?.length && !options.excludePatterns?.length) {
      return true;
    }
    
    // Check exclude patterns first (exclude takes precedence)
    if (options.excludePatterns?.length) {
      for (const pattern of options.excludePatterns) {
        if (this.pathMatchesPattern(path, pattern)) {
          return false;
        }
      }
    }
    
    // If include patterns are specified, at least one must match
    if (options.includePatterns?.length) {
      for (const pattern of options.includePatterns) {
        if (this.pathMatchesPattern(path, pattern)) {
          return true;
        }
      }
      // If we get here, no include pattern matched
      return false;
    }
    
    // No include patterns and didn't match any exclude patterns
    return true;
  }
  
  /**
   * Check if a path matches a glob pattern
   */
  private pathMatchesPattern(path: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // This is a simplified implementation - for production, use a proper glob library
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(path);
  }
}