import { BaseOAuthProvider } from './providers/BaseOAuthProvider.js';
import { GitHubProvider } from './providers/GitHubProvider.js';
import { NotionProvider } from './providers/NotionProvider.js';
import { OAuthConfig } from './config.js';
import { 
  OAuthProvider, 
  OAuthFlowOptions, 
  OAuthInitResponse, 
  OAuthCallbackData, 
  OAuthFlowResult, 
  StandardTokenData 
} from './types.js';
import { StateManager } from './managers/StateManager.js';
import { TokenManager } from './managers/TokenManager.js';

export class OAuthFlowManager {
  private providers = new Map<string, BaseOAuthProvider>();
  private stateManager: StateManager;
  private tokenManager: TokenManager;

  constructor(stateManager?: StateManager, tokenManager?: TokenManager) {
    this.stateManager = stateManager || StateManager.getInstance();
    this.tokenManager = tokenManager || TokenManager.getInstance();
    this.initializeProviders();
  }

  private initializeProviders(): void {
    // Initialize from environment variables
    OAuthConfig.initializeFromEnv();

    // Register GitHub provider if configured
    if (OAuthConfig.hasConfig(OAuthProvider.GITHUB)) {
      const config = OAuthConfig.getConfig(OAuthProvider.GITHUB);
      this.providers.set(OAuthProvider.GITHUB, new GitHubProvider(config, this.stateManager, this.tokenManager));
    }

    // Register Notion provider if configured
    if (OAuthConfig.hasConfig(OAuthProvider.NOTION)) {
      const config = OAuthConfig.getConfig(OAuthProvider.NOTION);
      this.providers.set(OAuthProvider.NOTION, new NotionProvider(config, this.stateManager, this.tokenManager));
    }
  }

  /**
   * Get a provider instance
   */
  getProvider(provider: string): BaseOAuthProvider {
    const providerInstance = this.providers.get(provider.toLowerCase());
    if (!providerInstance) {
      throw new Error(`OAuth provider not found or not configured: ${provider}`);
    }
    return providerInstance;
  }

  /**
   * Check if a provider is available
   */
  hasProvider(provider: string): boolean {
    return this.providers.has(provider.toLowerCase());
  }

  /**
   * Get list of available providers
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Initiate OAuth flow for a provider
   */
  async initiateFlow(
    provider: string, 
    redirectUri: string, 
    options: OAuthFlowOptions = {}
  ): Promise<OAuthInitResponse> {
    const providerInstance = this.getProvider(provider);
    return await providerInstance.initiateFlow(redirectUri, options);
  }

  /**
   * Handle OAuth callback for a provider
   */
  async handleCallback(
    provider: string,
    userId: string,
    callbackData: OAuthCallbackData,
    redirectUri: string
  ): Promise<OAuthFlowResult> {
    const providerInstance = this.getProvider(provider);
    
    // Special handling for Notion which needs workspace info
    if (provider.toLowerCase() === OAuthProvider.NOTION) {
      return await this.handleNotionCallback(providerInstance as NotionProvider, userId, callbackData, redirectUri);
    }
    
    return await providerInstance.handleCallback(userId, callbackData, redirectUri);
  }

  /**
   * Special handling for Notion OAuth flow
   */
  private async handleNotionCallback(
    provider: NotionProvider,
    userId: string,
    callbackData: OAuthCallbackData,
    redirectUri: string
  ): Promise<OAuthFlowResult> {
    try {
      // Validate state
      const stateData = await this.stateManager.validateState(callbackData.state);
      if (!stateData) {
        return {
          success: false,
          error: 'Invalid or expired state parameter',
        };
      }

      // Exchange code for token and get workspace info
      const { tokenResponse, workspaceInfo } = await provider.exchangeCodeForTokenWithWorkspaceInfo(
        callbackData.code, 
        redirectUri
      );

      // Get user info from workspace info
      const userInfo = provider.getUserInfoFromWorkspace(workspaceInfo);

      // Create standardized token data
      const tokenData: StandardTokenData = {
        userId,
        provider: provider.getProviderName(),
        providerAccountId: workspaceInfo.workspace_id,
        accessToken: tokenResponse.access_token,
        scopes: [],
        additionalData: {
          workspace_id: workspaceInfo.workspace_id,
          workspace_name: workspaceInfo.workspace_name,
          bot_id: workspaceInfo.bot_id,
          workspace_icon: workspaceInfo.workspace_icon,
        },
      };

      // Store token securely
      await this.tokenManager.storeToken(tokenData);

      return {
        success: true,
        tokenData,
        userInfo,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Disconnect integration for a provider
   */
  async disconnect(provider: string, userId: string, providerAccountId?: string): Promise<void> {
    const providerInstance = this.getProvider(provider);
    await providerInstance.disconnect(userId, providerAccountId);
  }

  /**
   * Get stored token for a provider
   */
  async getToken(provider: string, userId: string, providerAccountId?: string): Promise<StandardTokenData | null> {
    const providerInstance = this.getProvider(provider);
    return await providerInstance.getToken(userId, providerAccountId);
  }

  /**
   * Validate environment configuration
   */
  static validateEnvironment(): string[] {
    return OAuthConfig.validateEnvironment();
  }
}