import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid'; // For generating a state parameter

export async function GET(request: Request) {
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const GITHUB_SCOPES = process.env.GITHUB_SCOPES;

  if (!GITHUB_CLIENT_ID || !GITHUB_SCOPES) {
    console.error('GitHub OAuth environment variables GITHUB_CLIENT_ID or GITHUB_SCOPES are not set.');
    return NextResponse.json({ error: 'Server configuration error for GitHub OAuth.' }, { status: 500 });
  }

  // Determine the base URL for the callback
  let appBaseUrl = process.env.NEXT_PUBLIC_APP_URL; // User-defined, expected to be an absolute URL
  if (!appBaseUrl) {
    if (process.env.NEXT_PUBLIC_VERCEL_URL) {
      appBaseUrl = `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
    } else {
      appBaseUrl = 'http://localhost:3000'; // Fallback for local development
    }
  }
  
  const redirect_uri = new URL('/api/settings/integrations/github/callback', appBaseUrl).toString();
  
  // Generate a random state string for CSRF protection
  const state = uuidv4();
  // TODO: Store the state temporarily (e.g., in a short-lived cookie or server-side session)
  // to verify it in the callback. For now, we'll skip this for simplicity but it's crucial for production.

  const { searchParams: clientRedirectParams } = new URL(request.url);
  const clientFinalRedirectPath = clientRedirectParams.get('redirect_uri') || '/settings/integrations';


  // Construct the GitHub authorization URL
  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.append('client_id', GITHUB_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', redirect_uri);
  authUrl.searchParams.append('scope', GITHUB_SCOPES);
  authUrl.searchParams.append('state', `${state}|${encodeURIComponent(clientFinalRedirectPath)}`); // Include client redirect path in state

  return NextResponse.redirect(authUrl.toString(), { status: 302 });
}
