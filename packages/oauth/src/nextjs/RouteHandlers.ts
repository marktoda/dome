import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { OAuthFlowManager } from '../OAuthFlowManager.js';
import { OAuthFlowResult } from '../types.js';

export interface NextJSOAuthConfig {
  baseUrl: string;
  successRedirectPath?: string;
  errorRedirectPath?: string;
  getUserId: (request: NextRequest) => Promise<string | null>;
  onSuccess?: (result: OAuthFlowResult, provider: string) => Promise<void>;
  onError?: (error: string, provider: string) => Promise<void>;
}

export class NextJSOAuthHandlers {
  private flowManager: OAuthFlowManager;
  private config: NextJSOAuthConfig;

  constructor(config: NextJSOAuthConfig, flowManager?: OAuthFlowManager) {
    this.config = config;
    this.flowManager = flowManager || new OAuthFlowManager();
  }

  /**
   * Create connect route handler
   */
  createConnectHandler(provider: string) {
    return async (request: NextRequest) => {
      try {
        const url = new URL(request.url);
        const redirectPath = url.searchParams.get('redirect') || this.config.successRedirectPath || '/';
        
        const redirectUri = `${this.config.baseUrl}/api/settings/integrations/${provider}/callback`;
        
        const { authUrl, state } = await this.flowManager.initiateFlow(provider, redirectUri, {
          redirectPath,
        });

        // Set state cookie for CSRF protection
        const cookieStore = cookies();
        cookieStore.set(`oauth_state_${provider}`, state, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 5 * 60, // 5 minutes
          path: '/',
        });

        return NextResponse.redirect(authUrl);
      } catch (error) {
        console.error(`OAuth connect error for ${provider}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Configuration error';
        const redirectUrl = `${this.config.baseUrl}${this.config.errorRedirectPath || '/settings/integrations'}?error=${encodeURIComponent(errorMessage)}`;
        return NextResponse.redirect(redirectUrl);
      }
    };
  }

  /**
   * Create callback route handler
   */
  createCallbackHandler(provider: string) {
    return async (request: NextRequest) => {
      try {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        // Handle OAuth errors
        if (error) {
          const errorDescription = url.searchParams.get('error_description') || error;
          await this.config.onError?.(errorDescription, provider);
          const redirectUrl = `${this.config.baseUrl}${this.config.errorRedirectPath || '/settings/integrations'}?error=${encodeURIComponent(errorDescription)}`;
          return NextResponse.redirect(redirectUrl);
        }

        if (!code || !state) {
          const errorMessage = 'Missing authorization code or state parameter';
          await this.config.onError?.(errorMessage, provider);
          const redirectUrl = `${this.config.baseUrl}${this.config.errorRedirectPath || '/settings/integrations'}?error=${encodeURIComponent(errorMessage)}`;
          return NextResponse.redirect(redirectUrl);
        }

        // Verify state from cookie
        const cookieStore = cookies();
        const storedState = cookieStore.get(`oauth_state_${provider}`)?.value;
        
        if (!storedState || storedState !== state) {
          const errorMessage = 'Invalid state parameter - possible CSRF attack';
          await this.config.onError?.(errorMessage, provider);
          const redirectUrl = `${this.config.baseUrl}${this.config.errorRedirectPath || '/settings/integrations'}?error=${encodeURIComponent(errorMessage)}`;
          return NextResponse.redirect(redirectUrl);
        }

        // Clear state cookie
        cookieStore.delete(`oauth_state_${provider}`);

        // Get user ID
        const userId = await this.config.getUserId(request);
        if (!userId) {
          const errorMessage = 'User not authenticated';
          await this.config.onError?.(errorMessage, provider);
          const redirectUrl = `${this.config.baseUrl}/login?redirect=${encodeURIComponent(request.url)}`;
          return NextResponse.redirect(redirectUrl);
        }

        // Handle OAuth callback
        const redirectUri = `${this.config.baseUrl}/api/settings/integrations/${provider}/callback`;
        const result = await this.flowManager.handleCallback(provider, userId, {
          code,
          state,
        }, redirectUri);

        if (result.success) {
          await this.config.onSuccess?.(result, provider);
          const redirectUrl = `${this.config.baseUrl}${this.config.successRedirectPath || '/settings/integrations'}?success=${encodeURIComponent(`${provider} integration connected successfully`)}`;
          return NextResponse.redirect(redirectUrl);
        } else {
          await this.config.onError?.(result.error || 'Unknown error', provider);
          const redirectUrl = `${this.config.baseUrl}${this.config.errorRedirectPath || '/settings/integrations'}?error=${encodeURIComponent(result.error || 'Unknown error')}`;
          return NextResponse.redirect(redirectUrl);
        }
      } catch (error) {
        console.error(`OAuth callback error for ${provider}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        await this.config.onError?.(errorMessage, provider);
        const redirectUrl = `${this.config.baseUrl}${this.config.errorRedirectPath || '/settings/integrations'}?error=${encodeURIComponent(errorMessage)}`;
        return NextResponse.redirect(redirectUrl);
      }
    };
  }

  /**
   * Create disconnect route handler
   */
  createDisconnectHandler(provider: string) {
    return async (request: NextRequest) => {
      try {
        const userId = await this.config.getUserId(request);
        if (!userId) {
          return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
        }

        // Get provider account ID if specified
        const url = new URL(request.url);
        const providerAccountId = url.searchParams.get('accountId') || undefined;

        await this.flowManager.disconnect(provider, userId, providerAccountId);

        return NextResponse.json({ 
          success: true, 
          message: `${provider} integration disconnected successfully` 
        });
      } catch (error) {
        console.error(`OAuth disconnect error for ${provider}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return NextResponse.json({ error: errorMessage }, { status: 500 });
      }
    };
  }

  /**
   * Create status route handler
   */
  createStatusHandler(provider: string) {
    return async (request: NextRequest) => {
      try {
        const userId = await this.config.getUserId(request);
        if (!userId) {
          return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
        }

        const url = new URL(request.url);
        const providerAccountId = url.searchParams.get('accountId') || undefined;

        const token = await this.flowManager.getToken(provider, userId, providerAccountId);
        
        return NextResponse.json({
          connected: !!token,
          accountId: token?.providerAccountId,
          scopes: token?.scopes,
          expiresAt: token?.expiresAt?.toISOString(),
        });
      } catch (error) {
        console.error(`OAuth status error for ${provider}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return NextResponse.json({ error: errorMessage }, { status: 500 });
      }
    };
  }
}

/**
 * Helper function to create all OAuth routes for a provider
 */
export function createOAuthRoutes(provider: string, config: NextJSOAuthConfig) {
  const handlers = new NextJSOAuthHandlers(config);

  return {
    connect: handlers.createConnectHandler(provider),
    callback: handlers.createCallbackHandler(provider),
    disconnect: handlers.createDisconnectHandler(provider),
    status: handlers.createStatusHandler(provider),
  };
}