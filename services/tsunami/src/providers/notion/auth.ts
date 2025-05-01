/**
 * Notion Authentication Manager
 *
 * This module handles API keys and OAuth integration with Notion,
 * including token exchange and secure storage.
 */
import { getLogger, metrics } from '@dome/logging';
import { ServiceError } from '@dome/common/src/errors';

/**
 * Notion OAuth Token Response
 */
interface NotionOAuthTokenResponse {
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
  private tokenStore: Map<string, string> = new Map(); // In-memory store (would be replaced with KV in production)

  constructor(env: Env) {
    this.clientId = (env as any).NOTION_CLIENT_ID || '';
    this.clientSecret = (env as any).NOTION_CLIENT_SECRET || '';
    this.redirectUri = (env as any).NOTION_REDIRECT_URI || '';

    this.log.info(
      { 
        hasClientId: !!this.clientId, 
        hasClientSecret: !!this.clientSecret,
        hasRedirectUri: !!this.redirectUri
      },
      'notion: auth manager initialized'
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
      state
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
  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    workspaceId: string;
    workspaceName: string;
    botId: string;
  }> {
    try {
      const startTime = performance.now();
      this.log.info({ code: code.substring(0, 6) + '...' }, 'notion: exchanging code for token');
      
      const tokenEndpoint = 'https://api.notion.com/v1/oauth/token';
      const authHeader = `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`;
      
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri
        })
      });
      
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '<no-body>');
        this.log.error(
          { status: response.status, body: errorBody },
          'notion: token exchange failed'
        );
        
        metrics.increment('notion.auth.token_exchange.errors');
        
        throw new ServiceError(`Notion token exchange failed: ${response.status} ${response.statusText}`, {
          context: { status: response.status }
        });
      }
      
      const tokenData = await response.json() as NotionOAuthTokenResponse;
      
      metrics.timing('notion.auth.token_exchange.latency_ms', performance.now() - startTime);
      metrics.increment('notion.auth.token_exchange.success');
      
      return {
        accessToken: tokenData.access_token,
        workspaceId: tokenData.workspace_id,
        workspaceName: tokenData.workspace_name,
        botId: tokenData.bot_id
      };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      
      this.log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'notion: token exchange error'
      );
      
      metrics.increment('notion.auth.token_exchange.errors');
      
      throw new ServiceError('Failed to exchange authorization code for token', {
        cause: error,
        context: { code: code.substring(0, 6) + '...' }
      });
    }
  }

  /**
   * Store a user's access token securely
   * 
   * @param userId - User ID
   * @param workspaceId - Notion workspace ID
   * @param token - Access token
   */
  async storeUserToken(userId: string, workspaceId: string, token: string): Promise<void> {
    try {
      const key = this.getStorageKey(userId, workspaceId);
      
      // In production, this would use a secure KV store or other storage
      this.tokenStore.set(key, token);
      
      this.log.info({ userId, workspaceId }, 'notion: token stored successfully');
      metrics.increment('notion.auth.token_stored');
    } catch (error) {
      this.log.error(
        { userId, workspaceId, error: error instanceof Error ? error.message : String(error) },
        'notion: error storing token'
      );
      
      metrics.increment('notion.auth.token_store.errors');
      
      throw new ServiceError('Failed to store user token', {
        cause: error,
        context: { userId, workspaceId }
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
      const key = this.getStorageKey(userId, workspaceId);
      
      // In production, this would use a secure KV store or other storage
      const token = this.tokenStore.get(key) || null;
      
      this.log.debug(
        { userId, workspaceId, found: !!token },
        'notion: token retrieval attempt'
      );
      
      metrics.increment('notion.auth.token_retrieved');
      
      return token;
    } catch (error) {
      this.log.error(
        { userId, workspaceId, error: error instanceof Error ? error.message : String(error) },
        'notion: error retrieving token'
      );
      
      metrics.increment('notion.auth.token_retrieve.errors');
      
      throw new ServiceError('Failed to retrieve user token', {
        cause: error,
        context: { userId, workspaceId }
      });
    }
  }

  /**
   * Create a storage key from user ID and workspace ID
   * 
   * @param userId - User ID
   * @param workspaceId - Notion workspace ID
   * @returns Storage key
   */
  private getStorageKey(userId: string, workspaceId: string): string {
    return `notion_token:${userId}:${workspaceId}`;
  }
}