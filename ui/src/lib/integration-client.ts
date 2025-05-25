import apiClient, { ApiError } from './api';
import type { IntegrationStatus, IntegrationPlatform } from './oauth-types';
import { getIntegrationConfig } from './integration-config';

/**
 * Result of a connection attempt.
 */
export interface ConnectResult {
  success: boolean;
  redirectUrl?: string;
  message?: string;
}

/**
 * Result of a disconnection attempt.
 */
export interface DisconnectResult {
  success: boolean;
  message: string;
}

/**
 * Options for connecting an integration.
 */
export interface ConnectOptions {
  /** Custom redirect URL after OAuth completion */
  redirectUrl?: string;
  /** Additional OAuth state parameters */
  state?: Record<string, string>;
}

/**
 * Enhanced error information for integration operations.
 */
export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly platform: IntegrationPlatform,
    public readonly operation: 'connect' | 'disconnect' | 'status',
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/**
 * Client for managing external integrations.
 * Replaces the mock system with real API calls.
 */
export class IntegrationClient {
  /**
   * Get the current status of all integrations for the authenticated user.
   */
  async getAllIntegrationsStatus(): Promise<IntegrationStatus[]> {
    try {
      return await apiClient.get<IntegrationStatus[]>('/settings/integrations');
    } catch (error) {
      console.error('Failed to fetch integration statuses:', error);
      if (error instanceof ApiError) {
        throw new IntegrationError(
          `Failed to fetch integration statuses: ${error.message}`,
          'github', // Default platform for generic errors
          'status',
          error
        );
      }
      throw new IntegrationError(
        'Failed to fetch integration statuses',
        'github',
        'status',
        error as Error
      );
    }
  }

  /**
   * Get the status of a specific integration.
   */
  async getIntegrationStatus(platform: IntegrationPlatform): Promise<IntegrationStatus | null> {
    try {
      const config = getIntegrationConfig(platform);
      return await apiClient.get<IntegrationStatus>(config.endpoints.status);
    } catch (error) {
      console.error(`Failed to fetch ${platform} integration status:`, error);
      if (error instanceof ApiError && error.status === 404) {
        // Not connected
        return null;
      }
      throw new IntegrationError(
        `Failed to fetch ${platform} integration status`,
        platform,
        'status',
        error as Error
      );
    }
  }

  /**
   * Initiate the OAuth connection flow for an integration.
   */
  async connectIntegration(
    platform: IntegrationPlatform,
    options: ConnectOptions = {}
  ): Promise<ConnectResult> {
    try {
      const config = getIntegrationConfig(platform);
      
      const response = await apiClient.post<{ redirectUrl: string }>(
        config.endpoints.connect,
        {
          redirectUrl: options.redirectUrl,
          state: options.state,
        }
      );

      return {
        success: true,
        redirectUrl: response.redirectUrl,
        message: `Successfully initiated ${platform} connection`,
      };
    } catch (error) {
      console.error(`Failed to connect ${platform} integration:`, error);
      
      const errorMessage = error instanceof ApiError && error.data?.message
        ? error.data.message
        : `Failed to connect ${platform} integration`;

      throw new IntegrationError(
        errorMessage,
        platform,
        'connect',
        error as Error
      );
    }
  }

  /**
   * Disconnect and revoke an integration.
   */
  async disconnectIntegration(platform: IntegrationPlatform): Promise<DisconnectResult> {
    try {
      const config = getIntegrationConfig(platform);
      
      const response = await apiClient.post<{ success: boolean; message: string }>(
        config.endpoints.disconnect
      );

      return {
        success: response.success,
        message: response.message || `Successfully disconnected ${platform}`,
      };
    } catch (error) {
      console.error(`Failed to disconnect ${platform} integration:`, error);
      
      const errorMessage = error instanceof ApiError && error.data?.message
        ? error.data.message
        : `Failed to disconnect ${platform} integration`;

      throw new IntegrationError(
        errorMessage,
        platform,
        'disconnect',
        error as Error
      );
    }
  }

  /**
   * Retry a failed integration operation with exponential backoff.
   */
  async retryOperation<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === maxAttempts) {
          break;
        }

        // Exponential backoff
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`Operation failed, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Check if an integration supports specific features.
   */
  supportsRevoke(platform: IntegrationPlatform): boolean {
    const config = getIntegrationConfig(platform);
    return config.features.supportsRevoke;
  }

  /**
   * Check if an integration supports token refresh.
   */
  supportsRefresh(platform: IntegrationPlatform): boolean {
    const config = getIntegrationConfig(platform);
    return config.features.supportsRefresh;
  }

  /**
   * Check if an integration is workspace-aware.
   */
  isWorkspaceAware(platform: IntegrationPlatform): boolean {
    const config = getIntegrationConfig(platform);
    return config.features.workspaceAware;
  }
}

/**
 * Singleton instance of the integration client.
 */
export const integrationClient = new IntegrationClient();

export default integrationClient;