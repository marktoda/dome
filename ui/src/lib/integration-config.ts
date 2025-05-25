import type { IntegrationPlatform } from './oauth-types';

/**
 * Core configuration for an integration platform.
 * Contains all the metadata and endpoints needed for a specific integration.
 */
export interface IntegrationConfig {
  /** Unique identifier for the platform */
  platform: IntegrationPlatform;
  /** User-friendly display name */
  name: string;
  /** Brief description of what this integration provides */
  description: string;
  /** Category for grouping integrations */
  category: 'code' | 'docs' | 'communication' | 'storage';
  /** API endpoints for this integration */
  endpoints: {
    /** Endpoint to initiate OAuth connection */
    connect: string;
    /** Endpoint to disconnect/revoke the integration */
    disconnect: string;
    /** Endpoint to check current connection status */
    status: string;
  };
  /** OAuth configuration */
  oauth: {
    /** Required OAuth scopes */
    scopes: string[];
    /** Additional OAuth parameters */
    authParams?: Record<string, string>;
  };
  /** Features supported by this integration */
  features: {
    /** Can revoke tokens programmatically */
    supportsRevoke: boolean;
    /** Supports token refresh */
    supportsRefresh: boolean;
    /** Can sync workspace/organization data */
    workspaceAware: boolean;
  };
}

/**
 * Centralized configuration for all supported integrations.
 * This makes it easy to add new integrations and maintain consistency.
 */
export const INTEGRATION_CONFIGS: Record<IntegrationPlatform, IntegrationConfig> = {
  github: {
    platform: 'github',
    name: 'GitHub',
    description: 'Connect your GitHub repositories for code search and analysis',
    category: 'code',
    endpoints: {
      connect: '/api/settings/integrations/github/connect',
      disconnect: '/api/settings/integrations/github/disconnect',
      status: '/api/settings/integrations/github/status',
    },
    oauth: {
      scopes: ['repo', 'user:email'],
      authParams: {},
    },
    features: {
      supportsRevoke: true,
      supportsRefresh: false, // GitHub tokens don't expire
      workspaceAware: true,
    },
  },
  notion: {
    platform: 'notion',
    name: 'Notion',
    description: 'Sync your Notion pages and databases for content search',
    category: 'docs',
    endpoints: {
      connect: '/api/settings/integrations/notion/connect',
      disconnect: '/api/settings/integrations/notion/disconnect', 
      status: '/api/settings/integrations/notion/status',
    },
    oauth: {
      scopes: [], // Notion uses different scope structure
      authParams: {},
    },
    features: {
      supportsRevoke: false, // Notion doesn't support programmatic revoke
      supportsRefresh: false, // Notion tokens don't expire
      workspaceAware: true,
    },
  },
};

/**
 * Get configuration for a specific integration platform.
 */
export function getIntegrationConfig(platform: IntegrationPlatform): IntegrationConfig {
  const config = INTEGRATION_CONFIGS[platform];
  if (!config) {
    throw new Error(`Unknown integration platform: ${platform}`);
  }
  return config;
}

/**
 * Get all available integration configurations.
 */
export function getAllIntegrationConfigs(): IntegrationConfig[] {
  return Object.values(INTEGRATION_CONFIGS);
}

/**
 * Get integrations by category.
 */
export function getIntegrationsByCategory(category: IntegrationConfig['category']): IntegrationConfig[] {
  return getAllIntegrationConfigs().filter(config => config.category === category);
}

/**
 * Check if a platform is supported.
 */
export function isSupportedPlatform(platform: string): platform is IntegrationPlatform {
  return platform in INTEGRATION_CONFIGS;
}