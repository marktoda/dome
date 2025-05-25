/**
 * Base OAuth Manager
 * 
 * Provides common OAuth flow patterns that can be extended by specific providers.
 * This standardizes OAuth operations across different platforms.
 */
import { getLogger, metrics, trackedFetch, getRequestId } from '@dome/common';
import { ServiceError } from '@dome/common/errors';
import { TokenService } from '../../services/tokenService';
import type { ServiceEnv } from '../../config/env';

/**
 * OAuth configuration for a specific provider
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authBaseUrl: string;
  tokenEndpoint: string;
  scopes?: string[];
  additionalAuthParams?: Record<string, string>;
}

/**
 * Standard OAuth token response structure
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  [key: string]: any; // Allow provider-specific fields
}

/**
 * OAuth flow result
 */
export interface OAuthResult<T = OAuthTokenResponse> {
  success: boolean;
  tokenResponse?: T;
  error?: string;
}

/**
 * Base OAuth Manager class that provides common OAuth operations.
 * Should be extended by provider-specific OAuth managers.
 */
export abstract class BaseOAuthManager {
  protected readonly log = getLogger();
  protected readonly tokenService: TokenService;
  protected readonly platform: string;

  constructor(env: ServiceEnv, platform: string) {
    this.platform = platform;
    this.tokenService = new TokenService(
      env.SYNC_PLAN,
      env.TOKEN_ENCRYPTION_KEY,
    );

    this.log.info(
      { platform, hasConfig: !!this.getOAuthConfig() },
      'oauth: base manager initialized',
    );
  }

  /**
   * Get the OAuth configuration for this provider.
   * Must be implemented by subclasses.
   */
  protected abstract getOAuthConfig(): OAuthConfig;

  /**
   * Transform the provider-specific token response into standardized format.
   * Override this if the provider uses non-standard field names.
   */
  protected transformTokenResponse(response: any): OAuthTokenResponse {
    return response as OAuthTokenResponse;
  }

  /**
   * Generate the OAuth authorization URL
   */
  generateAuthUrl(state: string, additionalParams?: Record<string, string>): string {
    const config = this.getOAuthConfig();
    
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state,
      ...(config.scopes && config.scopes.length > 0 && { scope: config.scopes.join(' ') }),
      ...config.additionalAuthParams,
      ...additionalParams,
    });

    const url = `${config.authBaseUrl}?${params.toString()}`;

    this.log.debug({ platform: this.platform, state }, 'oauth: generated auth URL');

    return url;
  }

  /**
   * Exchange an authorization code for an access token
   */
  async exchangeCodeForToken<T = OAuthTokenResponse>(code: string): Promise<T> {
    const config = this.getOAuthConfig();
    
    try {
      const startTime = performance.now();
      this.log.info(
        { platform: this.platform, code: code.substring(0, 6) + '...' },
        'oauth: exchanging code for token',
      );

      const authHeader = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
      const requestId = getRequestId();

      const body = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
      };

      const response = await trackedFetch(
        config.tokenEndpoint,
        {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            'User-Agent': `Tsunami-OAuth/${this.platform}`,
          },
          body: JSON.stringify(body),
        },
        { operation: 'exchangeCodeForToken', platform: this.platform, requestId },
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '<no-body>');
        this.log.error(
          { platform: this.platform, status: response.status, body: errorBody },
          'oauth: token exchange failed',
        );

        metrics.increment(`${this.platform}.auth.token_exchange.errors`);

        throw new ServiceError(
          `${this.platform} token exchange failed: ${response.status} ${response.statusText}`,
          {
            context: { platform: this.platform, status: response.status },
          },
        );
      }

      const tokenData = await response.json();
      const transformedData = this.transformTokenResponse(tokenData) as T;

      metrics.timing(`${this.platform}.auth.token_exchange.latency_ms`, performance.now() - startTime);
      metrics.increment(`${this.platform}.auth.token_exchange.success`);

      return transformedData;
    } catch (error) {
      if (error instanceof ServiceError) throw error;

      this.log.error(
        {
          platform: this.platform,
          error: error instanceof Error ? error.message : String(error),
        },
        'oauth: token exchange error',
      );

      metrics.increment(`${this.platform}.auth.token_exchange.errors`);

      throw new ServiceError(`Failed to exchange authorization code for ${this.platform} token`, {
        cause: error,
        context: { platform: this.platform, code: code.substring(0, 6) + '...' },
      });
    }
  }

  /**
   * Store OAuth token details for a user
   */
  async storeUserToken(userId: string, tokenData: any, workspaceId?: string): Promise<void> {
    try {
      await this.tokenService.storeToken(this.platform, userId, tokenData, workspaceId);

      this.log.info(
        { platform: this.platform, userId, workspaceId },
        'oauth: token stored successfully',
      );
      metrics.increment(`${this.platform}.auth.token_stored`);
    } catch (error) {
      this.log.error(
        {
          platform: this.platform,
          userId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        'oauth: error storing token',
      );
      metrics.increment(`${this.platform}.auth.token_store.errors`);
      throw new ServiceError(`Failed to store ${this.platform} token`, {
        cause: error,
        context: { platform: this.platform, userId, workspaceId },
      });
    }
  }

  /**
   * Retrieve a stored token for a user
   */
  async getUserToken(userId: string, workspaceId?: string): Promise<string | null> {
    try {
      const tokenRecord = await this.tokenService.getToken(userId, this.platform, workspaceId);

      if (tokenRecord) {
        this.log.debug(
          { platform: this.platform, userId, workspaceId, found: true },
          'oauth: token retrieval successful',
        );
        metrics.increment(`${this.platform}.auth.token_retrieved`);
        return tokenRecord.accessToken;
      }

      this.log.debug(
        { platform: this.platform, userId, workspaceId, found: false },
        'oauth: token not found',
      );
      metrics.increment(`${this.platform}.auth.token_not_found`);
      return null;
    } catch (error) {
      this.log.error(
        {
          platform: this.platform,
          userId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        'oauth: error retrieving token',
      );
      metrics.increment(`${this.platform}.auth.token_retrieve.errors`);
      throw new ServiceError(`Failed to retrieve ${this.platform} token`, {
        cause: error,
        context: { platform: this.platform, userId, workspaceId },
      });
    }
  }

  /**
   * Delete a stored token for a user (used for disconnection)
   */
  async deleteUserToken(userId: string, workspaceId?: string): Promise<boolean> {
    try {
      const deleted = await this.tokenService.deleteToken(userId, this.platform, workspaceId);

      this.log.info(
        { platform: this.platform, userId, workspaceId, deleted },
        'oauth: token deletion attempt',
      );

      if (deleted) {
        metrics.increment(`${this.platform}.auth.token_deleted`);
      }

      return deleted;
    } catch (error) {
      this.log.error(
        {
          platform: this.platform,
          userId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        'oauth: error deleting token',
      );
      metrics.increment(`${this.platform}.auth.token_delete.errors`);
      throw new ServiceError(`Failed to delete ${this.platform} token`, {
        cause: error,
        context: { platform: this.platform, userId, workspaceId },
      });
    }
  }

  /**
   * Check if a user has a valid token stored
   */
  async hasValidToken(userId: string, workspaceId?: string): Promise<boolean> {
    try {
      const token = await this.getUserToken(userId, workspaceId);
      return token !== null;
    } catch (error) {
      this.log.warn(
        {
          platform: this.platform,
          userId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        'oauth: error checking token validity',
      );
      return false;
    }
  }

  /**
   * Generate a secure state parameter for OAuth flows
   */
  generateState(): string {
    // Generate a cryptographically secure random state
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Validate OAuth state parameter
   */
  validateState(expectedState: string, receivedState: string): boolean {
    if (!expectedState || !receivedState) {
      this.log.warn({ platform: this.platform }, 'oauth: missing state parameter');
      return false;
    }

    if (expectedState !== receivedState) {
      this.log.warn({ platform: this.platform }, 'oauth: state parameter mismatch');
      return false;
    }

    return true;
  }
}