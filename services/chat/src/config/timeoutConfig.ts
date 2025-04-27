/**
 * Timeout Configuration
 *
 * This file defines configuration options for timeouts used throughout the chat service.
 * These options control how long various operations can run before timing out.
 *
 * @module config/timeoutConfig
 */

/**
 * Configuration options for timeouts
 */
export interface TimeoutConfig {
  /**
   * Default timeout for LLM service calls in milliseconds
   */
  llmServiceTimeout: number;

  /**
   * Timeout for search operations in milliseconds
   */
  searchTimeout: number;

  /**
   * Timeout for document processing in milliseconds
   */
  documentProcessingTimeout: number;
}

/**
 * Environment-specific configurations
 */
const ENVIRONMENT_CONFIGS: Record<string, Partial<TimeoutConfig>> = {
  development: {
    // Development environment can have longer timeouts for debugging
    llmServiceTimeout: 60000, // 60 seconds
    searchTimeout: 45000, // 45 seconds
    documentProcessingTimeout: 30000, // 30 seconds
  },

  production: {
    // Production uses the default settings
    // Shorter timeouts for better user experience
    llmServiceTimeout: 30000, // 30 seconds
    searchTimeout: 20000, // 20 seconds
    documentProcessingTimeout: 15000, // 15 seconds
  },

  test: {
    // Test environment can have shorter timeouts for faster tests
    llmServiceTimeout: 10000, // 10 seconds
    searchTimeout: 5000, // 5 seconds
    documentProcessingTimeout: 5000, // 5 seconds
  },
};

/**
 * Default configuration for timeouts
 */
export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  llmServiceTimeout: 30000, // 30 seconds
  searchTimeout: 20000, // 20 seconds
  documentProcessingTimeout: 15000, // 15 seconds
};

/**
 * Get the current environment
 * @returns The current environment name
 */
function getCurrentEnvironment(): string {
  // Check for environment variables that might indicate the environment
  // Default to 'development' if not specified
  return 'development';
}

/**
 * Get the timeout configuration for the current environment
 * @returns The environment-specific timeout configuration
 */
export function getTimeoutConfig(): TimeoutConfig {
  const environment = getCurrentEnvironment();
  const envConfig = ENVIRONMENT_CONFIGS[environment] || {};

  // Merge the environment config with the default config
  return {
    ...DEFAULT_TIMEOUT_CONFIG,
    ...envConfig,
  };
}
