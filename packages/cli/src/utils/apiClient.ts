import { DomeApiClient } from '@dome/dome-sdk';
import { loadConfig } from './config';
import { ensureValidAccessToken } from './auth';

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
export async function getApiClient(): Promise<DomeApiClient> {
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

  // Determine token (if logged in). If no API key yet (e.g., during login/register),
  // create an unauthenticated client.
  let accessToken: string | undefined;
  if (currentConfig.apiKey) {
    accessToken = await ensureValidAccessToken();
  }

  const options: DomeApiClient.Options = accessToken
    ? { environment: currentConfig.baseUrl, token: accessToken }
    : { environment: currentConfig.baseUrl };

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

/**
 * Returns the configured API base URL.
 * @returns The API base URL string.
 * @throws Error if baseUrl is not configured.
 */
export function getApiBaseUrl(): string {
  const currentConfig = loadConfig();
  if (!currentConfig.baseUrl) {
    throw new Error(
      'API base URL is not configured. Please run `dome config set --base-url <your_api_url>` or ensure DOME_ENV is set.',
    );
  }
  return currentConfig.baseUrl;
}
