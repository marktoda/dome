/**
 * @file Manages configuration for authentication providers.
 */

import {
  SupportedAuthProvider,
  AuthProvidersConfig,
  ProviderConfig,
} from '../types';

/**
 * Retrieves the configuration for all authentication providers.
 * This is a placeholder implementation. In a real application,
 * this would load configuration from environment variables, a config service,
 * or a secure vault, and would be more robust.
 *
 * Example environment variables:
 * AUTH_EMAIL_ENABLED=true
 * AUTH_GOOGLE_CLIENT_ID=your_google_client_id
 * AUTH_GOOGLE_CLIENT_SECRET=your_google_client_secret
 * AUTH_GOOGLE_CALLBACK_URL=https://yourapi.com/auth/google/callback
 * AUTH_GOOGLE_SCOPES=email,profile
 * AUTH_GOOGLE_ENABLED=true
 *
 * @param env - The environment object, typically context.env in a Cloudflare Worker.
 * @returns Configuration for all supported authentication providers.
 */
export function getAuthProvidersConfig(env: any): AuthProvidersConfig {
  const config: AuthProvidersConfig = {};

  // Local Provider Configuration (Email/Password)
  config[SupportedAuthProvider.LOCAL] = {
    isEnabled: true, // Local provider should always be enabled
    // Email provider might not have client ID/secret but other settings
  };

  // Google Provider Configuration
  const googleScopes = env.AUTH_GOOGLE_SCOPES
    ? env.AUTH_GOOGLE_SCOPES.split(',')
    : ['email', 'profile'];

  config[SupportedAuthProvider.GOOGLE] = {
    clientId: env.AUTH_GOOGLE_CLIENT_ID,
    clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET, // IMPORTANT: Handle secrets securely
    callbackUrl: env.AUTH_GOOGLE_CALLBACK_URL,
    scopes: googleScopes,
    isEnabled:
      env.AUTH_GOOGLE_ENABLED === 'true' &&
      !!env.AUTH_GOOGLE_CLIENT_ID &&
      !!env.AUTH_GOOGLE_CLIENT_SECRET,
  };

  // GitHub Provider Configuration (Example structure)
  const githubScopes = env.AUTH_GITHUB_SCOPES
    ? env.AUTH_GITHUB_SCOPES.split(',')
    : ['read:user', 'user:email'];

  config[SupportedAuthProvider.GITHUB] = {
    clientId: env.AUTH_GITHUB_CLIENT_ID,
    clientSecret: env.AUTH_GITHUB_CLIENT_SECRET, // IMPORTANT: Handle secrets securely
    callbackUrl: env.AUTH_GITHUB_CALLBACK_URL,
    scopes: githubScopes,
    isEnabled:
      env.AUTH_GITHUB_ENABLED === 'true' &&
      !!env.AUTH_GITHUB_CLIENT_ID &&
      !!env.AUTH_GITHUB_CLIENT_SECRET,
  };

  // Add configurations for other providers here

  return config;
}

/**
 * Retrieves the configuration for a specific authentication provider.
 * @param providerName - The name of the provider.
 * @param env - The environment object.
 * @returns The configuration for the specified provider, or undefined if not found or not enabled.
 */
export function getProviderConfig(
  providerName: SupportedAuthProvider,
  env: any,
): ProviderConfig | undefined {
  const allConfigs = getAuthProvidersConfig(env);
  const config = allConfigs[providerName];
  return config?.isEnabled ? config : undefined;
}
