/**
 * Notion Authentication Manager
 *
 * This module handles API keys and OAuth integration with Notion,
 * including token exchange and secure storage.
 */
import { BaseOAuthManager, OAuthConfig } from '../oauth/BaseOAuthManager';
import { OAuthErrorHandler, OAuthError } from '../oauth/OAuthErrorHandler';
import type { NotionOAuthDetails } from '../../client/types'; // Corrected path
import type { ServiceEnv } from '../../config/env';

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
export class NotionAuthManager extends BaseOAuthManager {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(env: ServiceEnv) {
    super(env, 'notion');
    this.clientId = env.NOTION_CLIENT_ID ?? '';
    this.clientSecret = env.NOTION_CLIENT_SECRET ?? '';
    this.redirectUri = env.NOTION_REDIRECT_URI ?? '';
  }

  /**
   * Get OAuth configuration for Notion
   */
  protected getOAuthConfig(): OAuthConfig {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      authBaseUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
      additionalAuthParams: {
        owner: 'user',
      },
    };
  }

  /**
   * Generate the OAuth authorization URL for Notion
   * Uses the base class implementation with Notion-specific parameters
   */
  getAuthUrl(state: string): string {
    return this.generateAuthUrl(state);
  }

  /**
   * Exchange an authorization code for an access token
   * Uses the base class implementation and returns Notion-specific response
   */
  async exchangeCodeForToken(code: string): Promise<NotionOAuthTokenResponse> {
    try {
      return await super.exchangeCodeForToken<NotionOAuthTokenResponse>(code);
    } catch (error) {
      // Log Notion-specific error details and re-throw
      if (error instanceof OAuthError) {
        OAuthErrorHandler.logOAuthError(error);
      }
      throw error;
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
    const details: NotionOAuthDetails = {
      userId,
      accessToken: notionTokenResponse.access_token,
      workspaceId: notionTokenResponse.workspace_id,
      workspaceName: notionTokenResponse.workspace_name,
      workspaceIcon: notionTokenResponse.workspace_icon,
      botId: notionTokenResponse.bot_id,
      owner: notionTokenResponse.owner,
    };

    // Use the base class method for storing tokens
    await this.storeUserToken(userId, details, notionTokenResponse.workspace_id);
  }

  /**
   * Retrieve a user's access token
   * Uses the base class implementation
   */
  async getUserToken(userId: string, workspaceId: string): Promise<string | null> {
    return super.getUserToken(userId, workspaceId);
  }

  /**
   * Delete a user's stored token (for disconnection)
   */
  async deleteUserToken(userId: string, workspaceId: string): Promise<boolean> {
    return super.deleteUserToken(userId, workspaceId);
  }

  /**
   * Check if a user has a valid Notion token
   */
  async hasValidToken(userId: string, workspaceId: string): Promise<boolean> {
    return super.hasValidToken(userId, workspaceId);
  }
}
