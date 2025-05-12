import { DomeApiClient } from '@dome/dome-sdk';
import { loadConfig } from './config';

let apiClientInstance: DomeApiClient | null = null;
let lastUsedConfig: { baseUrl?: string; apiKey?: string } | null = null;

/**
 * Initializes and returns an instance of the DomeApiClient.
 * It uses the configuration loaded by `loadConfig` to set the
 * base URL and authentication token.
 * If the configuration (baseUrl or apiKey) has changed since the last
 * instantiation, a new client instance is created.
 *
 * @returns An instance of DomeApiClient.
 * @throws Error if baseUrl is not configured.
 */
export function getApiClient(): DomeApiClient {
  const currentConfig = loadConfig();

  if (
    apiClientInstance &&
    lastUsedConfig &&
    currentConfig.baseUrl === lastUsedConfig.baseUrl &&
    currentConfig.apiKey === lastUsedConfig.apiKey
  ) {
    return apiClientInstance;
  }

  if (!currentConfig.baseUrl) {
    // This case should ideally be handled by config validation or a default
    // but as a safeguard for the SDK client:
    throw new Error(
      'API base URL is not configured. Please run `dome config set --base-url <your_api_url>` or ensure DOME_ENV is set.',
    );
  }

  const options: DomeApiClient.Options = {
    environment: currentConfig.baseUrl, // Use the resolved baseUrl from CLI config
    token: currentConfig.apiKey, // Let the SDK handle the "Bearer" prefix
  };

  apiClientInstance = new DomeApiClient(options);
  lastUsedConfig = {
    baseUrl: currentConfig.baseUrl,
    apiKey: currentConfig.apiKey,
  };

  return apiClientInstance;
}

/**
 * Clears the cached API client instance and its last used configuration.
 * Useful for explicit resets like logout or for testing.
 */
export function clearApiClientInstance(): void {
  apiClientInstance = null;
  lastUsedConfig = null;
}
