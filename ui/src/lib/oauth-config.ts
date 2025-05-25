import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { NextJSOAuthConfig } from '@dome/oauth';

const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL!;

async function getUserId(request: NextRequest): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const authToken = cookieStore.get('auth_token');
    
    if (!authToken?.value) {
      return null;
    }

    // Validate token with backend and extract user info
    const response = await fetch(`${DOME_API_URL}/auth/verify-token`, {
      headers: { 
        'Authorization': `Bearer ${authToken.value}`,
        'Content-Type': 'application/json',
      }
    });
    
    if (response.ok) {
      const userData = await response.json();
      return userData.user?.id || null;
    }
    
    return null;
  } catch (error) {
    console.error('Error getting user ID:', error);
    return null;
  }
}

async function storeIntegrationInBackend(provider: string, tokenData: any, userInfo: any, authToken: string): Promise<void> {
  const endpoint = provider === 'github' ? '/content/github/oauth/store' : '/content/notion/oauth/store';
  
  const payload = provider === 'github' 
    ? {
        accessToken: tokenData.accessToken,
        scope: tokenData.scopes?.join(' ') || '',
        tokenType: 'Bearer',
        githubUserId: userInfo.id,
        githubUsername: userInfo.additionalInfo?.login,
      }
    : {
        accessToken: tokenData.accessToken,
        workspaceId: userInfo.id,
        workspaceName: userInfo.name,
        botId: userInfo.additionalInfo?.bot_id,
      };

  const response = await fetch(`${DOME_API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Failed to parse backend response' }));
    throw new Error(`Failed to store ${provider} integration: ${errorData.message || response.statusText}`);
  }
}

export const oauthConfig: NextJSOAuthConfig = {
  baseUrl: process.env.NEXT_PUBLIC_APP_URL || 
           (process.env.NEXT_PUBLIC_VERCEL_URL ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` : 'http://localhost:3000'),
  successRedirectPath: '/settings/integrations',
  errorRedirectPath: '/settings/integrations',
  getUserId,
  
  async onSuccess(result, provider) {
    try {
      // Get auth token for backend API call
      const cookieStore = await cookies();
      const authToken = cookieStore.get('auth_token');
      
      if (!authToken?.value) {
        throw new Error('User authentication token not found');
      }

      // Store integration in backend
      await storeIntegrationInBackend(provider, result.tokenData!, result.userInfo!, authToken.value);
      
      console.log(`${provider} integration stored successfully`);
    } catch (error) {
      console.error(`Error storing ${provider} integration:`, error);
      throw error; // Re-throw to trigger error handling
    }
  },

  async onError(error, provider) {
    console.error(`OAuth error for ${provider}:`, error);
  },
};