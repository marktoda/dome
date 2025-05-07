import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db'; // Placeholder for actual DB operations

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
  const appBaseUrl = process.env.NEXT_PUBLIC_VERCEL_URL
    ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

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

    // 3. Store integration details (using mock DB for now)
    // In a real app, you'd store accessToken (encrypted), githubUser.id, githubUser.login, etc., in your database.
    // And associate it with your application's user ID.
    const userId = 'default-user'; // TODO: Replace with actual user ID from session/auth
    updateMockIntegrationStatus(
      userId,
      'github',
      true,
      {
        name: githubUser.name || githubUser.login,
        email: githubUser.email, // Note: email might be null if not public or not in scopes
        username: githubUser.login,
        profileUrl: githubUser.html_url,
        // Store other relevant details like githubUser.id, accessToken (encrypted)
      }
    );

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
