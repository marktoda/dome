import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db'; // Placeholder

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateFromNotion = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    console.error('Notion OAuth error:', error);
    // Redirect back to frontend with error
    const [originalStateValue, encodedClientRedirectPath] = stateFromNotion?.split('|') || [null, null];
    const clientFinalRedirectPath = encodedClientRedirectPath ? decodeURIComponent(encodedClientRedirectPath) : '/settings/integrations';
    let appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.NEXT_PUBLIC_VERCEL_URL ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` : 'http://localhost:3000');
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.append('oauth_callback', 'true');
    errorRedirectUrl.searchParams.append('platform', 'notion');
    errorRedirectUrl.searchParams.append('status', 'error');
    errorRedirectUrl.searchParams.append('error_message', `Notion OAuth error: ${error}`);
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
  }

  if (!code || !stateFromNotion) {
    return NextResponse.json({ error: 'Missing code or state from Notion' }, { status: 400 });
  }

  // TODO: Retrieve and verify the original state value stored before redirecting to Notion.
  const [originalStateValue, encodedClientRedirectPath] = stateFromNotion.split('|');
  const clientFinalRedirectPath = encodedClientRedirectPath ? decodeURIComponent(encodedClientRedirectPath) : '/settings/integrations';

  const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
  const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;

  if (!NOTION_CLIENT_ID || !NOTION_CLIENT_SECRET) {
    console.error('Notion OAuth environment variables NOTION_CLIENT_ID or NOTION_CLIENT_SECRET are not set.');
    return NextResponse.json({ error: 'Server configuration error for Notion OAuth.' }, { status: 500 });
  }

  let appBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appBaseUrl) {
    appBaseUrl = process.env.NEXT_PUBLIC_VERCEL_URL ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` : 'http://localhost:3000';
  }
  const redirect_uri_for_token_exchange = new URL('/api/settings/integrations/notion/callback', appBaseUrl).toString();

  // Basic Auth header for Notion: base64(client_id:client_secret)
  const authHeader = `Basic ${Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64')}`;

  try {
    // 1. Exchange authorization code for an access token
    const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect_uri_for_token_exchange,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error('Notion token exchange error:', errorData);
      return NextResponse.json({ error: 'Failed to exchange Notion code for token', details: errorData }, { status: 500 });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const workspaceName = tokenData.workspace_name;
    const workspaceIcon = tokenData.workspace_icon;
    const botId = tokenData.bot_id; // The user object representing your integration

    if (!accessToken) {
      console.error('Notion access token not found in response:', tokenData);
      return NextResponse.json({ error: 'Access token not found in Notion response' }, { status: 500 });
    }

    // 2. Notion doesn't have a separate "get user" endpoint for OAuth like GitHub.
    // The token response already contains workspace info and bot_id.
    // You might want to store tokenData.owner which contains info about the authorizing user if available.
    // For now, we'll use the workspace name.

    // 3. Store integration details (using mock DB for now)
    const userId = 'default-user'; // TODO: Replace with actual user ID from session/auth
    updateMockIntegrationStatus(
      userId,
      'notion',
      true,
      {
        name: workspaceName || 'Notion Workspace', // Use workspace name
        // email: tokenData.owner?.user?.person?.email, // This structure might vary or not be available
        // username: tokenData.owner?.user?.id, // Or bot_id
        profileUrl: workspaceIcon, // Using workspace icon as a stand-in for profileUrl
      }
    );
    
    // 4. Redirect user back to the frontend
    const finalRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    finalRedirectUrl.searchParams.append('oauth_callback', 'true');
    finalRedirectUrl.searchParams.append('platform', 'notion');
    finalRedirectUrl.searchParams.append('status', 'success');

    return NextResponse.redirect(finalRedirectUrl.toString(), { status: 302 });

  } catch (error) {
    console.error('Notion OAuth callback error:', error);
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.append('oauth_callback', 'true');
    errorRedirectUrl.searchParams.append('platform', 'notion');
    errorRedirectUrl.searchParams.append('status', 'error');
    errorRedirectUrl.searchParams.append('error_message', (error instanceof Error ? error.message : 'Unknown error during Notion OAuth callback.'));
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
  }
}