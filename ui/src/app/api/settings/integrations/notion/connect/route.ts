import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { v4 as uuidv4 } from 'uuid';

/**
 * Handles GET requests to `/api/settings/integrations/notion/connect`.
 * Initiates the Notion OAuth 2.0 authorization flow by redirecting the user to Notion.
 *
 * Flow:
 * 1. Checks for required environment variables (Notion Client ID).
 * 2. Determines the application's base URL to construct the callback URL.
 * 3. Generates a unique `state` parameter for CSRF protection **(Security TODO: Store and verify this state)**.
 * 4. Retrieves the desired final client redirect path from the request's query parameters (`redirect_uri`).
 * 5. Constructs the Notion authorization URL including client ID, callback URL, response type, owner, and state (embedding client redirect path).
 * 6. Redirects the user (302) to the constructed Notion authorization URL.
 *
 * @param request - The incoming NextRequest object. Can include a `redirect_uri` query parameter
 *                  specifying where the user should be redirected after successful OAuth flow completion.
 * @returns A NextResponse object performing a 302 redirect to Notion's authorization endpoint,
 *          or a JSON error response (500) if server configuration is missing.
 *
 * @security **Critical TODO:** This implementation generates a `state` parameter but does not store it
 *           for verification in the callback route (`/api/settings/integrations/notion/callback`).
 *           This is **essential** to prevent CSRF attacks. Implement a mechanism (e.g., short-lived HttpOnly cookie)
 *           to store the generated `state` and verify it upon callback. Embedding the client redirect path
 *           in the state is also less secure than storing it server-side associated with the state.
 */
export async function GET(request: NextRequest) { // Changed type to NextRequest
  const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;

  if (!NOTION_CLIENT_ID) {
    console.error('CRITICAL: Missing required environment variable NOTION_CLIENT_ID for Notion OAuth connect.');
    return NextResponse.json({ error: 'Server configuration error: Notion OAuth details missing.' }, { status: 500 });
  }

  // Determine the app's base URL for constructing the callback URL
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` || 'http://localhost:3000';
  const redirect_uri = new URL('/api/settings/integrations/notion/callback', appBaseUrl).toString();

  // --- State Generation (CSRF Protection) ---
  const stateValue = uuidv4();
  // !!! SECURITY TODO: Store `stateValue` securely (e.g., HttpOnly cookie with short expiry) !!!
  console.log(`Generated state for Notion OAuth: ${stateValue} (Storage TODO)`);
  // --- End State Generation ---

  // Get the desired final redirect path from the client request
  const clientFinalRedirectPath = request.nextUrl.searchParams.get('redirect_uri') || '/settings/integrations';

  // Combine state value and redirect path (less secure method, prefer server-side storage)
  const combinedState = `${stateValue}|${encodeURIComponent(clientFinalRedirectPath)}`;

  // Construct the Notion authorization URL
  const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.set('client_id', NOTION_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirect_uri);
  authUrl.searchParams.set('response_type', 'code'); // Required by Notion
  authUrl.searchParams.set('owner', 'user'); // Required by Notion
  authUrl.searchParams.set('state', combinedState);

  console.log(`Redirecting user to Notion for authorization: ${authUrl.toString()}`);

  // Redirect the user to Notion
  return NextResponse.redirect(authUrl.toString(), { status: 302 });
}
