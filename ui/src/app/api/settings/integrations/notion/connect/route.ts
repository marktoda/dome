import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

/**
 * Handles GET requests to `/api/settings/integrations/notion/connect`.
 * Initiates the Notion OAuth 2.0 authorization flow by redirecting the user to Notion.
 *
 * Flow:
 * 1. Checks for required environment variables (Notion Client ID).
 * 2. Determines the application's base URL to construct the callback URL.
 * 3. Generates a unique `state` parameter for CSRF protection.
 * 4. Retrieves the desired final client redirect path from the request's query parameters (`redirect_uri`).
 * 5. Constructs the Notion authorization URL including client ID, callback URL, response type, owner, and state (embedding client redirect path).
 * 6. Redirects the user (302) to the constructed Notion authorization URL.
 *
 * @param request - The incoming NextRequest object. Can include a `redirect_uri` query parameter
 *                  specifying where the user should be redirected after successful OAuth flow completion.
 * @returns A NextResponse object performing a 302 redirect to Notion's authorization endpoint,
 *          or a JSON error response (500) if server configuration is missing.
 *
 * The generated state is stored in a short-lived HttpOnly cookie and verified in
 * `/api/settings/integrations/notion/callback` to prevent CSRF attacks.
 */
export async function GET(request: NextRequest) {
  // Changed type to NextRequest
  const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;

  if (!NOTION_CLIENT_ID) {
    console.error(
      'CRITICAL: Missing required environment variable NOTION_CLIENT_ID for Notion OAuth connect.',
    );
    return NextResponse.json(
      { error: 'Server configuration error: Notion OAuth details missing.' },
      { status: 500 },
    );
  }

  // Determine the app's base URL for constructing the callback URL
  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` ||
    'http://localhost:3000';
  const redirect_uri = new URL('/api/settings/integrations/notion/callback', appBaseUrl).toString();

  // --- State Generation (CSRF Protection) ---
  const stateValue = randomBytes(16).toString('hex');
  console.error('Generated state for Notion OAuth');
  // --- End State Generation ---

  // Get the desired final redirect path from the client request
  const clientFinalRedirectPath =
    request.nextUrl.searchParams.get('redirect_uri') || '/settings/integrations';

  // Combine state value and redirect path (less secure method, prefer server-side storage)
  const combinedState = `${stateValue}|${encodeURIComponent(clientFinalRedirectPath)}`;

  // Construct the Notion authorization URL
  const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.set('client_id', NOTION_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirect_uri);
  authUrl.searchParams.set('response_type', 'code'); // Required by Notion
  authUrl.searchParams.set('owner', 'user'); // Required by Notion
  authUrl.searchParams.set('state', combinedState);

  console.error(`Redirecting user to Notion for authorization: ${authUrl.toString()}`);

  const response = NextResponse.redirect(authUrl.toString(), { status: 302 });
  response.cookies.set({
    name: 'notion_oauth_state',
    value: stateValue,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 300, // 5 minutes
  });
  return response;
}
