import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid'; // For generating a state parameter

export async function GET(request: Request) {
  const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;

  if (!NOTION_CLIENT_ID) {
    console.error('Notion OAuth environment variable NOTION_CLIENT_ID is not set.');
    return NextResponse.json({ error: 'Server configuration error for Notion OAuth.' }, { status: 500 });
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
  
  const redirect_uri = new URL('/api/settings/integrations/notion/callback', appBaseUrl).toString();
  
  // Generate a random state string for CSRF protection
  const state = uuidv4(); 
  // TODO: Store the state temporarily (e.g., in a short-lived cookie or server-side session) 
  // to verify it in the callback.

  const { searchParams: clientRedirectParams } = new URL(request.url);
  // The 'redirect_uri' from the client is the final path they want to land on after success.
  const clientFinalRedirectPath = clientRedirectParams.get('redirect_uri') || '/settings/integrations';

  // Construct the Notion authorization URL
  // Notion uses 'response_type=code' and 'owner=user'
  const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.append('client_id', NOTION_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', redirect_uri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('owner', 'user');
  authUrl.searchParams.append('state', `${state}|${encodeURIComponent(clientFinalRedirectPath)}`); // Include client redirect path in state

  return NextResponse.redirect(authUrl.toString(), { status: 302 });
}
