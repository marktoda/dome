/**
 * Retrieve Configuration
 *
 * This file defines configuration options for the document retrieval system.
 * These options control token allocation, document limits, and relevance scores.
 *
 * @module config/retrieveConfig
 */

/**
 * Configuration options for document retrieval
 */
export interface RetrieveConfig {
  /**
   * Token allocation percentages
   */
  tokenAllocation: {
    /**
     * Maximum percentage of model's context window to allocate per document
     * Used in retrieve.ts for truncating individual documents
     */
    maxPerDocument: number;
    
    /**
     * Maximum percentage of model's context window to allocate for all documents
     * Used in retrieve.ts for limiting total document tokens
     */
    maxForAllDocuments: number;
  };

  /**
   * Document limits
   */
  documentLimits: {
    /**
     * Maximum number of documents to include in the context
     */
    maxDocuments: number;
  };

  /**
   * Relevance score configuration
   */
  relevanceScores: {
    /**
     * Base minimum relevance score (before widening attempts)
     */
    baseMinRelevance: number;
    
    /**
     * Reduction in relevance score per widening attempt
     */
    wideningReduction: number;
    
    /**
     * Absolute minimum relevance score (floor)
     */
    minimumRelevanceFloor: number;
  };
}

/**
 * Environment-specific configurations
 */
const ENVIRONMENT_CONFIGS: Record<string, Partial<RetrieveConfig>> = {
  development: {
    // Development environment can have more lenient settings
    relevanceScores: {
      baseMinRelevance: 0.4,
      wideningReduction: 0.1,
      minimumRelevanceFloor: 0.1,
    },
    documentLimits: {
      maxDocuments: 8, // More documents for testing
    }
  },
  
  production: {
    // Production uses the default settings
  },
  
  test: {
    // Test environment can have more documents for thorough testing
    documentLimits: {
      maxDocuments: 10,
    }
  }
};

/**
 * Default configuration for document retrieval
 */
export const DEFAULT_RETRIEVE_CONFIG: RetrieveConfig = {
  tokenAllocation: {
    maxPerDocument: 0.1, // 10% of model's context window per document
    maxForAllDocuments: 0.5, // 50% of model's context window for all documents
  },
  documentLimits: {
    maxDocuments: 5, // Maximum 5 documents by default
  },
  relevanceScores: {
    baseMinRelevance: 0.5,
    wideningReduction: 0.1,
    minimumRelevanceFloor: 0.2,
  }
};

/**
 * Get the current environment
 * @returns The current environment name
 */
function getCurrentEnvironment(): string {
  // Check for environment variables that might indicate the environment
  // Default to 'development' if not specified
  return process.env.NODE_ENV || 'development';
}

/**
 * Get the configuration for the current environment
 * @returns The environment-specific configuration merged with defaults
 */
export function getRetrieveConfig(): RetrieveConfig {
  const environment = getCurrentEnvironment();
  const envConfig = ENVIRONMENT_CONFIGS[environment] || {};
  
  // Deep merge the environment config with the default config
  return {
    tokenAllocation: {
      ...DEFAULT_RETRIEVE_CONFIG.tokenAllocation,
      ...(envConfig.tokenAllocation || {})
    },
    documentLimits: {
      ...DEFAULT_RETRIEVE_CONFIG.documentLimits,
      ...(envConfig.documentLimits || {})
    },
    relevanceScores: {
      ...DEFAULT_RETRIEVE_CONFIG.relevanceScores,
      ...(envConfig.relevanceScores || {})
    }
  };
}

/**
 * Calculate the minimum relevance score based on widening attempts
 * @param wideningAttempts Number of widening attempts
 * @returns The calculated minimum relevance score
 */
export function calculateMinRelevanceScore(wideningAttempts: number): number {
  const config = getRetrieveConfig();
  return Math.max(
    config.relevanceScores.baseMinRelevance - 
    wideningAttempts * config.relevanceScores.wideningReduction,
    config.relevanceScores.minimumRelevanceFloor
  );
}