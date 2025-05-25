import { BaseOAuthProvider } from './BaseOAuthProvider.js';
import { OAuthTokenResponse, OAuthUserInfo } from '../types.js';

interface NotionTokenResponse {
  access_token: string;
  token_type: 'bearer';
  bot_id: string;
  workspace_name: string;
  workspace_icon: string;
  workspace_id: string;
  owner: {
    type: 'workspace';
    workspace: boolean;
  };
  duplicated_template_id?: string;
}

export class NotionProvider extends BaseOAuthProvider {
  getProviderName(): string {
    return 'notion';
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenResponse> {
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

    const response = await this.makeRequest<NotionTokenResponse>(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    return {
      access_token: response.access_token,
      token_type: response.token_type,
    };
  }

  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    // For Notion, we need to make the token exchange first to get workspace info
    // The user info comes from the token response itself
    // We'll need to get the workspace info from the token response
    
    // Since we already have the token, we need to get workspace details
    // For Notion, the "user" is actually the workspace
    const workspaceInfo = await this.getWorkspaceInfo(accessToken);

    return {
      id: workspaceInfo.workspace_id,
      name: workspaceInfo.workspace_name,
      avatar: workspaceInfo.workspace_icon,
      additionalInfo: {
        workspace_id: workspaceInfo.workspace_id,
        workspace_name: workspaceInfo.workspace_name,
        bot_id: workspaceInfo.bot_id,
        workspace_icon: workspaceInfo.workspace_icon,
      },
    };
  }

  private async getWorkspaceInfo(accessToken: string): Promise<NotionTokenResponse> {
    // For Notion, we need to store the workspace info from the initial token exchange
    // Since we can't re-fetch it, we'll need to pass it through the flow
    // This is a limitation of the current design - we'll need to modify the base class
    // For now, we'll throw an error indicating this needs special handling
    throw new Error('Notion workspace info should be provided during token exchange');
  }

  // Override the base method to handle Notion's special token response
  async exchangeCodeForTokenWithWorkspaceInfo(code: string, redirectUri: string): Promise<{
    tokenResponse: OAuthTokenResponse;
    workspaceInfo: NotionTokenResponse;
  }> {
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

    const workspaceInfo = await this.makeRequest<NotionTokenResponse>(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    return {
      tokenResponse: {
        access_token: workspaceInfo.access_token,
        token_type: workspaceInfo.token_type,
      },
      workspaceInfo,
    };
  }

  // Override getUserInfo to accept workspace info directly
  getUserInfoFromWorkspace(workspaceInfo: NotionTokenResponse): OAuthUserInfo {
    return {
      id: workspaceInfo.workspace_id,
      name: workspaceInfo.workspace_name,
      avatar: workspaceInfo.workspace_icon,
      additionalInfo: {
        workspace_id: workspaceInfo.workspace_id,
        workspace_name: workspaceInfo.workspace_name,
        bot_id: workspaceInfo.bot_id,
        workspace_icon: workspaceInfo.workspace_icon,
      },
    };
  }
}