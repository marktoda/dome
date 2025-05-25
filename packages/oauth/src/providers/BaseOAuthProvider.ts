import { 
  OAuthProviderConfig, 
  OAuthFlowOptions, 
  OAuthInitResponse, 
  OAuthCallbackData, 
  OAuthTokenResponse, 
  OAuthUserInfo, 
  StandardTokenData,
  OAuthFlowResult 
} from '../types.js';
import { StateManager } from '../managers/StateManager.js';
import { TokenManager } from '../managers/TokenManager.js';

export abstract class BaseOAuthProvider {
  protected config: OAuthProviderConfig;
  protected stateManager: StateManager;
  protected tokenManager: TokenManager;

  constructor(
    config: OAuthProviderConfig,
    stateManager?: StateManager,
    tokenManager?: TokenManager
  ) {
    this.config = config;
    this.stateManager = stateManager || StateManager.getInstance();
    this.tokenManager = tokenManager || TokenManager.getInstance();
  }

  /**
   * Abstract methods that must be implemented by provider-specific classes
   */
  abstract exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenResponse>;
  abstract getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
  abstract getProviderName(): string;

  /**
   * Initiate OAuth flow - generates authorization URL with state
   */
  async initiateFlow(redirectUri: string, options: OAuthFlowOptions = {}): Promise<OAuthInitResponse> {
    const state = await this.stateManager.generateState(
      options.redirectPath,
      options.additionalState
    );

    const authUrl = this.buildAuthUrl(redirectUri, state);

    return {
      authUrl,
      state,
    };
  }

  /**
   * Handle OAuth callback - validate state and exchange code for token
   */
  async handleCallback(
    userId: string,
    callbackData: OAuthCallbackData,
    redirectUri: string
  ): Promise<OAuthFlowResult> {
    try {
      // Validate state for CSRF protection
      const stateData = await this.stateManager.validateState(callbackData.state);
      if (!stateData) {
        return {
          success: false,
          error: 'Invalid or expired state parameter',
        };
      }

      // Exchange code for access token
      const tokenResponse = await this.exchangeCodeForToken(callbackData.code, redirectUri);
      
      // Get user info from provider
      const userInfo = await this.getUserInfo(tokenResponse.access_token);

      // Create standardized token data
      const tokenData: StandardTokenData = {
        userId,
        provider: this.getProviderName(),
        providerAccountId: userInfo.id,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: tokenResponse.expires_in 
          ? new Date(Date.now() + tokenResponse.expires_in * 1000)
          : undefined,
        scopes: tokenResponse.scope?.split(' '),
        additionalData: userInfo.additionalInfo,
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
   * Disconnect integration - revoke tokens
   */
  async disconnect(userId: string, providerAccountId?: string): Promise<void> {
    await this.tokenManager.revokeToken(userId, this.getProviderName(), providerAccountId);
  }

  /**
   * Get stored token for user
   */
  async getToken(userId: string, providerAccountId?: string): Promise<StandardTokenData | null> {
    return await this.tokenManager.getValidToken(userId, this.getProviderName(), providerAccountId);
  }

  /**
   * Build authorization URL with provider-specific parameters
   */
  protected buildAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      state,
      ...this.config.additionalParams,
    });

    if (this.config.scopes && this.config.scopes.length > 0) {
      params.set('scope', this.config.scopes.join(' '));
    }

    return `${this.config.authUrl}?${params.toString()}`;
  }

  /**
   * Make HTTP request with error handling
   */
  protected async makeRequest<T>(
    url: string, 
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  }

  /**
   * Validate required configuration
   */
  protected validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error(`Missing client ID for ${this.getProviderName()} provider`);
    }
    if (!this.config.clientSecret) {
      throw new Error(`Missing client secret for ${this.getProviderName()} provider`);
    }
    if (!this.config.authUrl) {
      throw new Error(`Missing auth URL for ${this.getProviderName()} provider`);
    }
    if (!this.config.tokenUrl) {
      throw new Error(`Missing token URL for ${this.getProviderName()} provider`);
    }
  }
}