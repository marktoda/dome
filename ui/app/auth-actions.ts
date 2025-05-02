'use server';

import { signIn, signOut } from '@/auth';
import { redirect } from 'next/navigation';

type SignInResult = {
  error?: string;
  ok: boolean;
  url?: string;
};

// Server action wrapper for signIn that can be safely called from client components
export async function serverSignIn(provider: string, callbackUrl?: string, options?: any): Promise<SignInResult> {
  try {
    // For credentials provider, direct the request to the proper API endpoint
    if (provider === 'credentials') {
      // When not using redirect, we need to handle it through the API
      if (options?.redirect === false) {
        const response = await fetch('/api/auth/edge-auth', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: options.email,
            password: options.password,
          }),
        });

        const data = await response.json();
        
        if (!data.success) {
          return {
            error: data.message || 'Authentication failed',
            ok: false
          };
        }

        // On success, use the normal auth flow to set the session
        await signIn('credentials', {
          redirect: true,
          email: options.email,
          password: options.password,
          callbackUrl: callbackUrl || '/dashboard'
        });

        return {
          ok: true,
          url: callbackUrl || '/dashboard'
        };
      }
    }
    
    // For OAuth providers or when we want to redirect
    return await signIn(provider, {
      callbackUrl: callbackUrl || '/dashboard',
      ...options
    }) as SignInResult;
  } catch (error) {
    console.error('Error in serverSignIn:', error);
    return {
      error: error instanceof Error ? error.message : 'Unknown error during sign in',
      ok: false
    };
  }
}

// Server action wrapper for signOut that can be safely called from client components
export async function serverSignOut(callbackUrl?: string) {
  return signOut({ redirectTo: callbackUrl || '/' });
}

// Helper for protected route redirection
export async function redirectToLogin(callbackUrl?: string) {
  const url = `/auth/login${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ''}`;
  redirect(url);
}