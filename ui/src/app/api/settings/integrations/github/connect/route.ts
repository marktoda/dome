import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { v4 as uuidv4 } from 'uuid';

/**
 * Handles GET requests to `/api/settings/integrations/github/connect`.
 * Initiates the GitHub OAuth 2.0 authorization flow by redirecting the user to GitHub.
 *
 * Flow:
 * 1. Checks for required environment variables (GitHub Client ID, Scopes).
 * 2. Determines the application's base URL to construct the callback URL.
 * 3. Generates a unique `state` parameter for CSRF protection **(Security TODO: Store and verify this state)**.
 * 4. Retrieves the desired final client redirect path from the request's query parameters (`redirect_uri`).
 * 5. Constructs the GitHub authorization URL including client ID, scopes, callback URL, and state (embedding client redirect path).
 * 6. Redirects the user (302) to the constructed GitHub authorization URL.
 *
 * @param request - The incoming NextRequest object. Can include a `redirect_uri` query parameter
 *                  specifying where the user should be redirected after successful OAuth flow completion.
 * @returns A NextResponse object performing a 302 redirect to GitHub's authorization endpoint,
 *          or a JSON error response (500) if server configuration is missing.
 *
 * @security **Critical TODO:** This implementation generates a `state` parameter but does not store it
 *           for verification in the callback route (`/api/settings/integrations/github/callback`).
 *           This is **essential** to prevent CSRF attacks. Implement a mechanism (e.g., short-lived HttpOnly cookie)
 *           to store the generated `state` and verify it upon callback. Embedding the client redirect path
 *           in the state is also less secure than storing it server-side associated with the state.
 */
export async function GET(request: NextRequest) {
  // Changed type to NextRequest
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const GITHUB_SCOPES = process.env.GITHUB_SCOPES; // e.g., "repo read:user user:email"

  if (!GITHUB_CLIENT_ID || !GITHUB_SCOPES) {
    console.error(
      'CRITICAL: Missing required environment variables for GitHub OAuth connect (GITHUB_CLIENT_ID, GITHUB_SCOPES).',
    );
    // Avoid redirecting if config is missing, return an error directly
    return NextResponse.json(
      { error: 'Server configuration error: GitHub OAuth details missing.' },
      { status: 500 },
    );
  }

  // Determine the app's base URL for constructing the callback URL
  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` ||
    'http://localhost:3000';
  const redirect_uri = new URL('/api/settings/integrations/github/callback', appBaseUrl).toString();

  // --- State Generation (CSRF Protection) ---
  const stateValue = uuidv4();
  // !!! SECURITY TODO: Store `stateValue` securely (e.g., HttpOnly cookie with short expiry) !!!
  // Example (conceptual, requires cookie library/helper):
  // const stateCookieOptions = { httpOnly: true, secure: true, path: '/', maxAge: 300 }; // 5 minutes
  // cookies().set('github_oauth_state', stateValue, stateCookieOptions);
  console.log(`Generated state for GitHub OAuth: ${stateValue} (Storage TODO)`);
  // --- End State Generation ---

  // Get the desired final redirect path from the client request
  const clientFinalRedirectPath =
    request.nextUrl.searchParams.get('redirect_uri') || '/settings/integrations';

  // Combine state value and redirect path (less secure method, prefer server-side storage)
  const combinedState = `${stateValue}|${encodeURIComponent(clientFinalRedirectPath)}`;

  // Construct the GitHub authorization URL
  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirect_uri);
  authUrl.searchParams.set('scope', GITHUB_SCOPES);
  authUrl.searchParams.set('state', combinedState);
  // Optional: add allow_signup=false if you don't want users creating new GitHub accounts during flow
  // authUrl.searchParams.set('allow_signup', 'false');

  console.log(`Redirecting user to GitHub for authorization: ${authUrl.toString()}`);

  // Redirect the user to GitHub
  return NextResponse.redirect(authUrl.toString(), { status: 302 });
}
