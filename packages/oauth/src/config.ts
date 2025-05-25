import { z } from 'zod';
import { OAuthProviderConfig, OAuthProvider } from './types.js';

const OAuthConfigSchema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  clientSecret: z.string().min(1, 'Client Secret is required'),
  scopes: z.array(z.string()).optional(),
  authUrl: z.string().url('Auth URL must be a valid URL'),
  tokenUrl: z.string().url('Token URL must be a valid URL'),
  userInfoUrl: z.string().url().optional(),
  additionalParams: z.record(z.string()).optional(),
});

export class OAuthConfig {
  private static configs = new Map<string, OAuthProviderConfig>();

  static setConfig(provider: string, config: OAuthProviderConfig): void {
    const validatedConfig = OAuthConfigSchema.parse(config);
    this.configs.set(provider.toLowerCase(), validatedConfig);
  }

  static getConfig(provider: string): OAuthProviderConfig {
    const config = this.configs.get(provider.toLowerCase());
    if (!config) {
      throw new Error(`OAuth configuration not found for provider: ${provider}`);
    }
    return config;
  }

  static hasConfig(provider: string): boolean {
    return this.configs.has(provider.toLowerCase());
  }

  static initializeFromEnv(): void {
    // GitHub configuration
    const githubClientId = process.env.GITHUB_CLIENT_ID;
    const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
    const githubScopes = process.env.GITHUB_SCOPES?.split(',') || ['user:email', 'read:org'];

    if (githubClientId && githubClientSecret) {
      this.setConfig(OAuthProvider.GITHUB, {
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        scopes: githubScopes,
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
      });
    }

    // Notion configuration
    const notionClientId = process.env.NOTION_CLIENT_ID;
    const notionClientSecret = process.env.NOTION_CLIENT_SECRET;

    if (notionClientId && notionClientSecret) {
      this.setConfig(OAuthProvider.NOTION, {
        clientId: notionClientId,
        clientSecret: notionClientSecret,
        authUrl: 'https://api.notion.com/v1/oauth/authorize',
        tokenUrl: 'https://api.notion.com/v1/oauth/token',
        additionalParams: {
          response_type: 'code',
          owner: 'user',
        },
      });
    }
  }

  static validateEnvironment(): string[] {
    const missingVars: string[] = [];

    // Check GitHub vars
    if (!process.env.GITHUB_CLIENT_ID) missingVars.push('GITHUB_CLIENT_ID');
    if (!process.env.GITHUB_CLIENT_SECRET) missingVars.push('GITHUB_CLIENT_SECRET');

    // Check Notion vars
    if (!process.env.NOTION_CLIENT_ID) missingVars.push('NOTION_CLIENT_ID');
    if (!process.env.NOTION_CLIENT_SECRET) missingVars.push('NOTION_CLIENT_SECRET');

    return missingVars;
  }
}