import { BaseOAuthProvider } from './BaseOAuthProvider.js';
import { OAuthTokenResponse, OAuthUserInfo } from '../types.js';

interface GitHubTokenResponse {
  access_token: string;
  scope: string;
  token_type: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  bio?: string;
  company?: string;
  location?: string;
}

export class GitHubProvider extends BaseOAuthProvider {
  getProviderName(): string {
    return 'github';
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenResponse> {
    const response = await this.makeRequest<GitHubTokenResponse>(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    return {
      access_token: response.access_token,
      scope: response.scope,
      token_type: response.token_type,
    };
  }

  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    if (!this.config.userInfoUrl) {
      throw new Error('User info URL not configured for GitHub provider');
    }

    const user = await this.makeRequest<GitHubUser>(this.config.userInfoUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'Dome-OAuth-Client',
      },
    });

    // Get user email if not provided in user object
    let email = user.email;
    if (!email) {
      const emails = await this.getUserEmails(accessToken);
      email = emails.find(e => e.primary)?.email || emails[0]?.email;
    }

    return {
      id: user.id.toString(),
      email,
      name: user.name || user.login,
      avatar: user.avatar_url,
      additionalInfo: {
        login: user.login,
        bio: user.bio,
        company: user.company,
        location: user.location,
      },
    };
  }

  private async getUserEmails(accessToken: string): Promise<Array<{ email: string; primary: boolean; verified: boolean }>> {
    try {
      return await this.makeRequest('https://api.github.com/user/emails', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Dome-OAuth-Client',
        },
      });
    } catch (error) {
      // Return empty array if we can't fetch emails (missing scope)
      return [];
    }
  }
}