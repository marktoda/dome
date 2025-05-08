import { NextResponse } from 'next/server';
import { cookies } from 'next/headers'; // Import cookies
// import { updateMockIntegrationStatus } from '@/lib/integration-mock-db'; // Replaced by dome-api call

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateFromGitHub = searchParams.get('state');

  if (!code || !stateFromGitHub) {
    return NextResponse.json({ error: 'Missing code or state from GitHub' }, { status: 400 });
  }

  // TODO: Retrieve and verify the original state value stored before redirecting to GitHub.
  // For now, we'll parse the client redirect path from the state.
  // This is a simplified approach and proper state verification (e.g., using a short-lived cookie) is crucial for CSRF protection.
  const [_originalStateValue, encodedClientRedirectPath] = stateFromGitHub.split('|');
  const clientFinalRedirectPath = encodedClientRedirectPath ? decodeURIComponent(encodedClientRedirectPath) : '/settings/integrations';


  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    console.error('GitHub OAuth environment variables GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET are not set.');
    return NextResponse.json({ error: 'Server configuration error for GitHub OAuth.' }, { status: 500 });
  }

  // Determine the base URL for the redirect URI used in the token exchange
  let appBaseUrl = process.env.NEXT_PUBLIC_APP_URL; // User-defined, expected to be an absolute URL
  if (!appBaseUrl) {
    if (process.env.NEXT_PUBLIC_VERCEL_URL) {
      appBaseUrl = `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
    } else {
      appBaseUrl = 'http://localhost:3000'; // Fallback for local development
    }
  }

  const redirect_uri_for_token_exchange = new URL('/api/settings/integrations/github/callback', appBaseUrl).toString();

  try {
    // 1. Exchange authorization code for an access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirect_uri_for_token_exchange, // Must match the redirect_uri used in the initial auth request if it was provided there.
        // Or, if not provided initially, GitHub uses the one registered with the app.
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error('GitHub token exchange error:', errorData);
      return NextResponse.json({ error: 'Failed to exchange GitHub code for token', details: errorData }, { status: 500 });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('GitHub access token not found in response:', tokenData);
      return NextResponse.json({ error: 'Access token not found in GitHub response' }, { status: 500 });
    }

    // 2. Use the access token to fetch user information
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!userResponse.ok) {
      const errorData = await userResponse.json();
      console.error('GitHub user fetch error:', errorData);
      return NextResponse.json({ error: 'Failed to fetch user information from GitHub', details: errorData }, { status: 500 });
    }

    const githubUser = await userResponse.json();

    // 3. Send integration details to dome-api to be stored by Tsunami
    // const userId = 'default-user'; // userId will be derived by dome-api from the forwarded auth token
    const domeApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (!domeApiBaseUrl) {
      console.error('NEXT_PUBLIC_API_BASE_URL is not set. Cannot store GitHub integration.');
      const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
      errorRedirectUrl.searchParams.append('oauth_callback', 'true');
      errorRedirectUrl.searchParams.append('platform', 'github');
      errorRedirectUrl.searchParams.append('status', 'error');
      errorRedirectUrl.searchParams.append('error_message', 'Server configuration error: API base URL missing.');
      return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    }

    const headers = new Headers({
      'Content-Type': 'application/json',
    });
    const cookieStore = await cookies(); // Assuming cookies() returns a Promise here based on previous fixes
    const authTokenCookie = cookieStore.get('auth_token'); // TODO: Confirm cookie name
    if (authTokenCookie?.value) {
      headers.append('Authorization', `Bearer ${authTokenCookie.value}`);
    }

    const storeIntegrationResponse = await fetch(`${domeApiBaseUrl}/content/github/oauth/store`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        accessToken,
        scope: tokenData.scope, // Assuming scope is in tokenData
        tokenType: tokenData.token_type, // Assuming token_type is in tokenData
        githubUserId: githubUser.id,
        githubUsername: githubUser.login,
      }),
    });

    if (!storeIntegrationResponse.ok) {
      const errorData = await storeIntegrationResponse.json().catch(() => ({ message: 'Failed to store GitHub integration and parse error response.' }));
      console.error('Failed to store GitHub integration via dome-api:', errorData);
      const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
      errorRedirectUrl.searchParams.append('oauth_callback', 'true');
      errorRedirectUrl.searchParams.append('platform', 'github');
      errorRedirectUrl.searchParams.append('status', 'error');
      errorRedirectUrl.searchParams.append('error_message', `Failed to save GitHub integration: ${errorData.message || storeIntegrationResponse.statusText}`);
      return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    }

    const storeResult = await storeIntegrationResponse.json();
    console.log('GitHub integration stored via dome-api:', storeResult);

    // 4. Redirect user back to the frontend
    const finalRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    // Add query params to indicate success to the frontend if needed
    finalRedirectUrl.searchParams.append('oauth_callback', 'true');
    finalRedirectUrl.searchParams.append('platform', 'github');
    finalRedirectUrl.searchParams.append('status', 'success');


    return NextResponse.redirect(finalRedirectUrl.toString(), { status: 302 });

  } catch (error) {
    console.error('GitHub OAuth callback error:', error);
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.append('oauth_callback', 'true');
    errorRedirectUrl.searchParams.append('platform', 'github');
    errorRedirectUrl.searchParams.append('status', 'error');
    errorRedirectUrl.searchParams.append('error_message', (error instanceof Error ? error.message : 'Unknown error during GitHub OAuth callback.'));
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
  }
}
