import { DomeApiClient } from '@dome/dome-sdk';
import { loadConfig } from './config';

let apiClientInstance: DomeApiClient | null = null;

/**
 * Initializes and returns an instance of the DomeApiClient.
 * It uses the configuration loaded by `loadConfig` to set the
 * base URL and authentication token.
 *
 * @returns An instance of DomeApiClient.
 */
export function getApiClient(): DomeApiClient {
  if (apiClientInstance) {
    return apiClientInstance;
  }

  const config = loadConfig();

  const options: DomeApiClient.Options = {
    environment: config.baseUrl, // Use the resolved baseUrl from CLI config
    token: config.apiKey ? `Bearer ${config.apiKey}` : undefined,
  };

  apiClientInstance = new DomeApiClient(options);
  return apiClientInstance;
}

/**
 * Clears the cached API client instance.
 * Useful for testing or if config changes during runtime (e.g., after login/logout).
 */
export function clearApiClientInstance(): void {
  apiClientInstance = null;
}
