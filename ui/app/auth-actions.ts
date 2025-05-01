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
    // If credentials provider is used with redirect:false, we need to handle it specially
    if (provider === 'credentials' && options?.redirect === false) {
      return await signIn('credentials', {
        ...options,
        redirect: false
      }) as SignInResult;
    }
    
    // For OAuth providers or when we want to redirect
    return await signIn(provider, { 
      redirectTo: callbackUrl,
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