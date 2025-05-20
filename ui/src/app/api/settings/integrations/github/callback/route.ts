import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

/**
 * Handles the GET request for the GitHub OAuth callback (`/api/settings/integrations/github/callback`).
 * This route is hit after the user authorizes the application on GitHub.
 *
 * Flow:
 * 1. Extracts the authorization `code` and `state` from the query parameters.
 * 2. Verifies the received `state` against the value stored in an HttpOnly cookie to prevent CSRF.
 * 3. Exchanges the `code` for a GitHub access token using client ID and secret.
 * 4. Uses the access token to fetch the authenticated user's GitHub profile information.
 * 5. Forwards the access token and relevant user details to the backend API (`/content/github/oauth/store`)
 *    along with the user's application authentication token (from cookie) for storage.
 * 6. Redirects the user back to the frontend settings page (or original path stored in state),
 *    appending status parameters (`oauth_callback`, `platform`, `status`, `error_message`).
 *
 * @param request - The incoming NextRequest object.
 * @returns A NextResponse object, typically a redirect (302) back to the frontend settings page.
 *          Redirects include query parameters indicating the success or failure of the OAuth flow.
 *          Returns JSON errors (400, 500) only for initial validation or configuration issues.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateFromGitHub = searchParams.get('state');

  // --- 1. Validate incoming parameters ---
  if (!code || !stateFromGitHub) {
    console.error('GitHub callback error: Missing code or state parameter.');
    // Redirecting with error is generally better UX than showing JSON here
    const errorRedirectUrl = new URL('/settings/integrations', request.nextUrl.origin); // Fallback redirect
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'github');
    errorRedirectUrl.searchParams.set('status', 'error');
    errorRedirectUrl.searchParams.set('error_message', 'Invalid callback parameters from GitHub.');
    const resp = NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    resp.cookies.set({
      name: 'github_oauth_state',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return resp;
    // return NextResponse.json({ error: 'Missing code or state from GitHub' }, { status: 400 });
  }

  // --- 2. State Verification (CSRF Protection) ---
  const [receivedState, encodedClientRedirectPath] = stateFromGitHub.split('|');
  const cookieStore = await cookies();
  const storedState = cookieStore.get('github_oauth_state');
  if (!storedState?.value || storedState.value !== receivedState) {
    console.error('GitHub OAuth state mismatch or missing.');
    const errorRedirectUrl = new URL('/settings/integrations', request.nextUrl.origin);
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'github');
    errorRedirectUrl.searchParams.set('status', 'error');
    errorRedirectUrl.searchParams.set('error_message', 'Invalid OAuth state.');
    const resp = NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    resp.cookies.set({
      name: 'github_oauth_state',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return resp;
  }
  const clientFinalRedirectPath = encodedClientRedirectPath
    ? decodeURIComponent(encodedClientRedirectPath)
    : '/settings/integrations';
  console.error(
    `GitHub callback state received. Extracted redirect path: ${clientFinalRedirectPath}`,
  );
  // --- End State Verification ---

  // --- Configuration Check ---
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
  const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL; // Backend API

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !DOME_API_URL) {
    console.error(
      'CRITICAL: Missing required environment variables for GitHub OAuth callback (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, NEXT_PUBLIC_API_BASE_URL).',
    );
    const errorRedirectUrl = new URL(clientFinalRedirectPath, request.nextUrl.origin);
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'github');
    errorRedirectUrl.searchParams.set('status', 'error');
    errorRedirectUrl.searchParams.set(
      'error_message',
      'Server configuration error preventing GitHub connection.',
    );
    const resp = NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    resp.cookies.set({
      name: 'github_oauth_state',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return resp;
    // return NextResponse.json({ error: 'Server configuration error for GitHub OAuth.' }, { status: 500 });
  }

  // Determine the app's base URL for constructing the redirect_uri
  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` ||
    'http://localhost:3000';
  const redirect_uri_for_token_exchange = new URL(
    '/api/settings/integrations/github/callback',
    appBaseUrl,
  ).toString();
  // --- End Configuration Check ---

  try {
    // --- 3. Exchange Code for Access Token ---
    console.error('Exchanging GitHub code for access token...');
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirect_uri_for_token_exchange,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse
        .json()
        .catch(() => ({ message: 'Failed to parse GitHub token error response.' }));
      console.error('GitHub token exchange failed:', tokenResponse.status, errorData);
      throw new Error(
        `GitHub token exchange failed: ${
          errorData.error_description || errorData.message || tokenResponse.statusText
        }`,
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('GitHub access token not found in response:', tokenData);
      throw new Error('Access token not found in GitHub response.');
    }
    console.error('GitHub access token obtained successfully.');
    // --- End Token Exchange ---

    // --- 4. Fetch GitHub User Info ---
    console.error('Fetching GitHub user information...');
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github.v3+json' },
    });

    if (!userResponse.ok) {
      const errorData = await userResponse
        .json()
        .catch(() => ({ message: 'Failed to parse GitHub user error response.' }));
      console.error('GitHub user fetch failed:', userResponse.status, errorData);
      throw new Error(
        `Failed to fetch user information from GitHub: ${
          errorData.message || userResponse.statusText
        }`,
      );
    }

    const githubUser = await userResponse.json();
    console.error(`GitHub user info fetched: ${githubUser.login} (ID: ${githubUser.id})`);
    // --- End User Info Fetch ---

    // --- 5. Store Integration Details via Backend API ---
    console.error('Storing GitHub integration details via backend API...');
    const apiHeaders = new Headers({ 'Content-Type': 'application/json' });
    const cookieStore = await cookies(); // Keep await based on previous fixes
    const authTokenCookie = cookieStore.get('auth_token'); // Ensure this is the correct cookie name

    if (!authTokenCookie?.value) {
      console.error('Authentication token cookie not found. Cannot store integration.');
      throw new Error('User authentication token not found.'); // Throw error to trigger final error redirect
    }
    apiHeaders.append('Authorization', `Bearer ${authTokenCookie.value}`);

    const storeIntegrationResponse = await fetch(`${DOME_API_URL}/content/github/oauth/store`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        accessToken,
        scope: tokenData.scope,
        tokenType: tokenData.token_type,
        githubUserId: githubUser.id,
        githubUsername: githubUser.login,
      }),
    });

    if (!storeIntegrationResponse.ok) {
      const errorData = await storeIntegrationResponse
        .json()
        .catch(() => ({ message: 'Failed to parse backend storage error response.' }));
      console.error(
        'Failed to store GitHub integration via backend API:',
        storeIntegrationResponse.status,
        errorData,
      );
      throw new Error(
        `Failed to save GitHub integration: ${
          errorData.message || storeIntegrationResponse.statusText
        }`,
      );
    }

    const storeResult = await storeIntegrationResponse.json();
    console.error('GitHub integration stored successfully via backend API');
    // --- End Integration Storage ---

    // --- 6. Redirect User Back to Frontend (Success) ---
    const finalRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    finalRedirectUrl.searchParams.set('oauth_callback', 'true');
    finalRedirectUrl.searchParams.set('platform', 'github');
    finalRedirectUrl.searchParams.set('status', 'success');
    console.error(`Redirecting user to success URL: ${finalRedirectUrl.toString()}`);
    const resp = NextResponse.redirect(finalRedirectUrl.toString(), { status: 302 });
    resp.cookies.set({
      name: 'github_oauth_state',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return resp;
  } catch (error) {
    // --- Error Handling & Redirect (Failure) ---
    console.error('GitHub OAuth callback processing error:', error);
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl); // Use extracted path
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'github');
    errorRedirectUrl.searchParams.set('status', 'error');
    // Provide a user-friendly error message, avoid leaking sensitive details
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'An unknown error occurred during GitHub connection.';
    errorRedirectUrl.searchParams.set('error_message', errorMessage);
    console.error(`Redirecting user to error URL: ${errorRedirectUrl.toString()}`);
    const resp = NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    resp.cookies.set({
      name: 'github_oauth_state',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return resp;
  }
}
