/**
 * Filter Configuration
 *
 * This file defines configuration options for the file filtering system.
 * These options control how the ignore pattern processor behaves.
 *
 * @module config/filterConfig
 */

/**
 * Configuration options for the file filtering system
 */
export interface FilterConfig {
  /**
   * Whether file filtering is enabled
   * If false, no files will be filtered regardless of patterns
   */
  enabled: boolean;

  /**
   * Whether to use default patterns when no .tsunamiignore file is found
   * If false, no filtering will occur when .tsunamiignore is absent
   */
  useDefaultPatternsWhenNoIgnoreFile: boolean;

  /**
   * The name of the ignore file to look for in repositories
   */
  ignoreFileName: string;

  /**
   * Whether to log detailed information about filtered files
   */
  logFilteredFiles: boolean;

  /**
   * Whether to track metrics about filtered files
   */
  trackFilterMetrics: boolean;
}

/**
 * Default configuration for the file filtering system
 */
export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  enabled: true,
  useDefaultPatternsWhenNoIgnoreFile: true,
  ignoreFileName: '.tsunamiignore',
  logFilteredFiles: true,
  trackFilterMetrics: true,
};
