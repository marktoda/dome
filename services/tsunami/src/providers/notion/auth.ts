/**
 * Notion Authentication Manager
 *
 * This module handles API keys and OAuth integration with Notion,
 * including token exchange and secure storage.
 */
import { getLogger, metrics } from '@dome/common';
import { ServiceError } from '@dome/common/src/errors';
import { TokenService, OAuthTokenRecord } from '../../services/tokenService'; // Corrected path
import type { NotionOAuthDetails } from '../../client/types'; // Corrected path
import type { ServiceEnv } from '../../resourceObject';

/**
 * Notion OAuth Token Response
 */
export interface NotionOAuthTokenResponse {
  // Added export
  access_token: string;
  workspace_id: string;
  workspace_name: string;
  workspace_icon: string;
  bot_id: string;
  owner?: {
    type: string;
    user?: {
      id: string;
      name: string;
      avatar_url: string;
    };
  };
}

/**
 * Notion Authentication Manager
 * Handles OAuth flow and token management for Notion API
 */
export class NotionAuthManager {
  private log = getLogger();
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  // private tokenStore: Map<string, string> = new Map(); // Replaced with TokenService
  private tokenService: TokenService;

  constructor(env: ServiceEnv) {
    this.clientId = (env as any).NOTION_CLIENT_ID || '';
    this.clientSecret = (env as any).NOTION_CLIENT_SECRET || '';
    this.redirectUri = (env as any).NOTION_REDIRECT_URI || '';
    this.tokenService = new TokenService(env.SYNC_PLAN); // Initialize TokenService

    this.log.info(
      {
        hasClientId: !!this.clientId,
        hasClientSecret: !!this.clientSecret,
        hasRedirectUri: !!this.redirectUri,
      },
      'notion: auth manager initialized',
    );
  }

  /**
   * Generate the OAuth authorization URL for Notion
   *
   * @param state - State parameter for OAuth security
   * @returns The full authorization URL
   */
  getAuthUrl(state: string): string {
    const baseUrl = 'https://api.notion.com/v1/oauth/authorize';
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      owner: 'user',
      state,
    });

    const url = `${baseUrl}?${params.toString()}`;

    this.log.debug({ state }, 'notion: generated auth URL');

    return url;
  }

  /**
   * Exchange an authorization code for an access token
   *
   * @param code - The authorization code from Notion OAuth callback
   * @returns Token response with access token and workspace details
   */
  async exchangeCodeForToken(code: string): Promise<NotionOAuthTokenResponse> {
    // Return full response
    try {
      const startTime = performance.now();
      this.log.info({ code: code.substring(0, 6) + '...' }, 'notion: exchanging code for token');

      const tokenEndpoint = 'https://api.notion.com/v1/oauth/token';
      const authHeader = `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`;

      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '<no-body>');
        this.log.error(
          { status: response.status, body: errorBody },
          'notion: token exchange failed',
        );

        metrics.increment('notion.auth.token_exchange.errors');

        throw new ServiceError(
          `Notion token exchange failed: ${response.status} ${response.statusText}`,
          {
            context: { status: response.status },
          },
        );
      }

      const tokenData = (await response.json()) as NotionOAuthTokenResponse;

      metrics.timing('notion.auth.token_exchange.latency_ms', performance.now() - startTime);
      metrics.increment('notion.auth.token_exchange.success');

      return tokenData; // Return the full tokenData object
    } catch (error) {
      if (error instanceof ServiceError) throw error;

      this.log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'notion: token exchange error',
      );

      metrics.increment('notion.auth.token_exchange.errors');

      throw new ServiceError('Failed to exchange authorization code for token', {
        cause: error,
        context: { code: code.substring(0, 6) + '...' },
      });
    }
  }

  /**
   * Store a user's Notion OAuth details securely using TokenService.
   *
   * @param userId - User ID from your application
   * @param notionTokenResponse - The full token response from Notion after code exchange
   */
  async storeUserNotionIntegration(
    userId: string,
    notionTokenResponse: NotionOAuthTokenResponse,
  ): Promise<void> {
    try {
      const details: NotionOAuthDetails = {
        userId,
        accessToken: notionTokenResponse.access_token,
        workspaceId: notionTokenResponse.workspace_id,
        workspaceName: notionTokenResponse.workspace_name,
        workspaceIcon: notionTokenResponse.workspace_icon,
        botId: notionTokenResponse.bot_id,
        owner: notionTokenResponse.owner,
        // duplicatedTemplateId is not directly in NotionOAuthTokenResponse, might be null or from elsewhere if needed
      };

      await this.tokenService.storeNotionToken(details);

      this.log.info(
        { userId, workspaceId: details.workspaceId },
        'notion: integration details stored successfully via TokenService',
      );
      metrics.increment('notion.auth.integration_stored');
    } catch (error) {
      this.log.error(
        {
          userId,
          workspaceId: notionTokenResponse.workspace_id,
          error: error instanceof Error ? error.message : String(error),
        },
        'notion: error storing integration details via TokenService',
      );
      metrics.increment('notion.auth.integration_store.errors');
      throw new ServiceError('Failed to store Notion integration details', {
        cause: error,
        context: { userId, workspaceId: notionTokenResponse.workspace_id },
      });
    }
  }

  /**
   * Retrieve a user's access token
   *
   * @param userId - User ID
   * @param workspaceId - Notion workspace ID
   * @returns The access token or null if not found
   */
  async getUserToken(userId: string, workspaceId: string): Promise<string | null> {
    try {
      const tokenRecord = await this.tokenService.getToken(userId, 'notion', workspaceId);

      if (tokenRecord) {
        this.log.debug(
          { userId, workspaceId, found: true },
          'notion: token retrieval attempt from TokenService successful',
        );
        metrics.increment('notion.auth.token_retrieved');
        // TODO: Decrypt tokenRecord.accessToken if it was encrypted by TokenService
        return tokenRecord.accessToken;
      }

      this.log.debug(
        { userId, workspaceId, found: false },
        'notion: token not found via TokenService',
      );
      metrics.increment('notion.auth.token_not_found');
      return null;
    } catch (error) {
      this.log.error(
        { userId, workspaceId, error: error instanceof Error ? error.message : String(error) },
        'notion: error retrieving token via TokenService',
      );
      metrics.increment('notion.auth.token_retrieve.errors');
      throw new ServiceError('Failed to retrieve user token via TokenService', {
        cause: error,
        context: { userId, workspaceId },
      });
    }
  }

  // getStorageKey is no longer needed as TokenService handles its own storage structure.
}
