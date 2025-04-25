import { getLogger } from '@dome/logging';

/**
 * Feature flag names
 */
export enum FeatureFlag {
  ENABLE_DYNAMIC_WIDENING = 'enable_dynamic_widening',
  ENABLE_TOOL_REGISTRY = 'enable_tool_registry',
  ENABLE_ADVANCED_RETRIEVAL = 'enable_advanced_retrieval',
  ENABLE_CACHING = 'enable_caching',
  ENABLE_PARALLEL_PROCESSING = 'enable_parallel_processing',
}

/**
 * Feature flag configuration interface
 */
export interface FeatureFlagConfig {
  flags: Record<string, boolean>;
  overrides?: Record<string, Record<string, boolean>>;
}

/**
 * Default feature flag configuration
 */
const DEFAULT_CONFIG: FeatureFlagConfig = {
  flags: {
    [FeatureFlag.ENABLE_DYNAMIC_WIDENING]: false,
    [FeatureFlag.ENABLE_TOOL_REGISTRY]: false,
    [FeatureFlag.ENABLE_ADVANCED_RETRIEVAL]: false,
    [FeatureFlag.ENABLE_CACHING]: false,
    [FeatureFlag.ENABLE_PARALLEL_PROCESSING]: false,
  },
  overrides: {
    // Override flags for specific user IDs
    // 'user-123': {
    //   [FeatureFlag.ENABLE_DYNAMIC_WIDENING]: true,
    // },
  },
};

/**
 * Feature flag service for managing feature flags
 */
export class FeatureFlagService {
  private static config: FeatureFlagConfig = DEFAULT_CONFIG;
  private static logger = getLogger().child({ component: 'FeatureFlagService' });

  /**
   * Initialize the feature flag service with configuration
   * @param config Feature flag configuration
   */
  static initialize(config: FeatureFlagConfig): void {
    this.config = {
      flags: { ...DEFAULT_CONFIG.flags, ...config.flags },
      overrides: { ...DEFAULT_CONFIG.overrides, ...config.overrides },
    };
    
    this.logger.info(
      { 
        flagCount: Object.keys(this.config.flags).length,
        overrideCount: Object.keys(this.config.overrides || {}).length,
      },
      'Feature flag service initialized'
    );
  }

  /**
   * Check if a feature flag is enabled
   * @param flag Feature flag name
   * @param userId Optional user ID for user-specific overrides
   * @returns True if the feature is enabled, false otherwise
   */
  static isEnabled(flag: FeatureFlag, userId?: string): boolean {
    // Check for user-specific override
    if (userId && this.config.overrides && this.config.overrides[userId]) {
      const userOverride = this.config.overrides[userId][flag];
      if (userOverride !== undefined) {
        return userOverride;
      }
    }
    
    // Fall back to global flag
    return this.config.flags[flag] || false;
  }

  /**
   * Enable a feature flag globally
   * @param flag Feature flag name
   */
  static enableFlag(flag: FeatureFlag): void {
    this.config.flags[flag] = true;
    this.logger.info({ flag }, 'Feature flag enabled globally');
  }

  /**
   * Disable a feature flag globally
   * @param flag Feature flag name
   */
  static disableFlag(flag: FeatureFlag): void {
    this.config.flags[flag] = false;
    this.logger.info({ flag }, 'Feature flag disabled globally');
  }

  /**
   * Set a user-specific override for a feature flag
   * @param userId User ID
   * @param flag Feature flag name
   * @param enabled Whether the feature should be enabled for this user
   */
  static setUserOverride(userId: string, flag: FeatureFlag, enabled: boolean): void {
    if (!this.config.overrides) {
      this.config.overrides = {};
    }
    
    if (!this.config.overrides[userId]) {
      this.config.overrides[userId] = {};
    }
    
    this.config.overrides[userId][flag] = enabled;
    
    this.logger.info(
      { 
        userId, 
        flag, 
        enabled,
      },
      'User-specific feature flag override set'
    );
  }

  /**
   * Remove a user-specific override for a feature flag
   * @param userId User ID
   * @param flag Feature flag name
   */
  static removeUserOverride(userId: string, flag: FeatureFlag): void {
    if (this.config.overrides && this.config.overrides[userId]) {
      delete this.config.overrides[userId][flag];
      
      // Clean up empty objects
      if (Object.keys(this.config.overrides[userId]).length === 0) {
        delete this.config.overrides[userId];
      }
      
      this.logger.info(
        { 
          userId, 
          flag,
        },
        'User-specific feature flag override removed'
      );
    }
  }

  /**
   * Get the current feature flag configuration
   * @returns Feature flag configuration
   */
  static getConfig(): FeatureFlagConfig {
    return { ...this.config };
  }
}