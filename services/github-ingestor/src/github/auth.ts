import { App } from '@octokit/app';
// Temporarily comment out this import until we can install the package
// import { createAppAuth } from '@octokit/auth-app';
import { initPolyfills } from '../utils/polyfills';

// Initialize polyfills
initPolyfills();
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { Env } from '../types';

/**
 * GitHub authentication error
 */
export class GitHubAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly isTransient: boolean = false,
  ) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

/**
 * Get a GitHub App installation token
 * @param appId GitHub App ID
 * @param privateKey GitHub App private key
 * @param installationId GitHub App installation ID
 * @returns Installation token
 */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<string> {
  const timer = metrics.startTimer('github_auth.get_installation_token');

  try {
    const app = new App({
      appId,
      privateKey,
    });

    // Temporary implementation until we can install @octokit/auth-app
    // This is a placeholder that will be replaced with the actual implementation
    const auth = {
      createAppAuth: () => ({
        getInstallationAccessToken: async () => ({
          token: 'placeholder-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      }),
    };

    // Use the temporary auth implementation
    const { token } = await auth.createAppAuth().getInstallationAccessToken();

    metrics.trackOperation('github_auth.get_installation_token', true);
    timer.stop();

    return token;
  } catch (error) {
    metrics.trackOperation('github_auth.get_installation_token', false);
    timer.stop();

    logError(error as Error, 'Failed to get GitHub App installation token');

    throw new GitHubAuthError(
      `Failed to get GitHub App installation token: ${(error as Error).message}`,
      'installation_token_failed',
      true,
    );
  }
}

/**
 * Get a GitHub token for a user
 * @param userId User ID
 * @param env Environment
 * @returns GitHub token
 */
export async function getUserToken(userId: string, env: Env): Promise<string> {
  const timer = metrics.startTimer('github_auth.get_user_token');

  try {
    // Get the user's GitHub credentials from the database
    const credentials = await env.DB.prepare(
      `
      SELECT accessToken, tokenExpiry, refreshToken
      FROM provider_credentials
      WHERE userId = ?
      AND provider = 'github'
    `,
    )
      .bind(userId)
      .first();

    if (!credentials) {
      throw new GitHubAuthError(
        `No GitHub credentials found for user ${userId}`,
        'credentials_not_found',
        false,
      );
    }

    const { accessToken, tokenExpiry, refreshToken } = credentials as {
      accessToken: string;
      tokenExpiry: number;
      refreshToken: string;
    };

    // Check if the token is expired
    const now = Math.floor(Date.now() / 1000);

    if (tokenExpiry && tokenExpiry < now) {
      // Token is expired, refresh it
      return await refreshUserToken(userId, refreshToken, env);
    }

    metrics.trackOperation('github_auth.get_user_token', true);
    timer.stop();

    return accessToken;
  } catch (error) {
    metrics.trackOperation('github_auth.get_user_token', false);
    timer.stop();

    if (error instanceof GitHubAuthError) {
      throw error;
    }

    logError(error as Error, 'Failed to get GitHub user token');

    throw new GitHubAuthError(
      `Failed to get GitHub user token: ${(error as Error).message}`,
      'user_token_failed',
      true,
    );
  }
}

/**
 * Refresh a user's GitHub token
 * @param userId User ID
 * @param refreshToken Refresh token
 * @param env Environment
 * @returns New access token
 */
async function refreshUserToken(userId: string, refreshToken: string, env: Env): Promise<string> {
  const timer = metrics.startTimer('github_auth.refresh_user_token');

  try {
    // GitHub's OAuth token endpoint
    const tokenUrl = 'https://github.com/login/oauth/access_token';

    // Get the client ID and secret from environment variables
    // These should be added to the Env interface and wrangler.toml
    const clientId = (env as any).GITHUB_CLIENT_ID;
    const clientSecret = (env as any).GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new GitHubAuthError(
        'GitHub OAuth client ID or secret not configured',
        'oauth_config_missing',
        false,
      );
    }

    // Make the token refresh request
    const response = await globalThis.fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new GitHubAuthError(
        `Failed to refresh token: ${response.status} ${response.statusText}`,
        'refresh_token_failed',
        response.status >= 500,
      );
    }

    interface TokenResponse {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    }

    const data = (await response.json()) as TokenResponse;

    if (!data.access_token) {
      throw new GitHubAuthError(
        'No access token in refresh response',
        'refresh_token_invalid',
        false,
      );
    }

    // Calculate the new expiry time (GitHub tokens typically last 8 hours)
    const expiresIn = data.expires_in || 28800; // Default to 8 hours
    const newExpiry = Math.floor(Date.now() / 1000) + expiresIn;

    // Update the token in the database
    await env.DB.prepare(
      `
      UPDATE provider_credentials
      SET accessToken = ?, tokenExpiry = ?, refreshToken = ?, updatedAt = ?
      WHERE userId = ? AND provider = 'github'
    `,
    )
      .bind(
        data.access_token,
        newExpiry,
        data.refresh_token || refreshToken, // Use new refresh token if provided
        Math.floor(Date.now() / 1000),
        userId,
      )
      .run();

    metrics.trackOperation('github_auth.refresh_user_token', true);
    timer.stop();

    return data.access_token;
  } catch (error) {
    metrics.trackOperation('github_auth.refresh_user_token', false);
    timer.stop();

    if (error instanceof GitHubAuthError) {
      throw error;
    }

    logError(error as Error, 'Failed to refresh GitHub token');

    throw new GitHubAuthError(
      `Failed to refresh GitHub token: ${(error as Error).message}`,
      'refresh_token_failed',
      true,
    );
  }
}

/**
 * Verify a GitHub webhook signature
 * @param payload Webhook payload
 * @param signature Webhook signature (x-hub-signature-256 header)
 * @param secret Webhook secret
 * @returns Whether the signature is valid
 */
export async function verifyGitHubWebhook(
  payload: any,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    // Convert the payload to a string if it's not already
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);

    // Create a crypto key from the secret
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );

    // Calculate the expected signature
    const expectedSignature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(payloadString),
    );

    // Convert the expected signature to a hex string
    const expectedSignatureHex = Array.from(new Uint8Array(expectedSignature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Compare the signatures
    const providedSignature = signature.replace('sha256=', '');

    return providedSignature === expectedSignatureHex;
  } catch (error) {
    logError(error as Error, 'Failed to verify GitHub webhook signature');
    return false;
  }
}

/**
 * Get a service account token for public repositories
 * @param env Environment
 * @returns Service account token
 */
export function getServiceToken(env: Env): string {
  return env.GITHUB_TOKEN;
}
