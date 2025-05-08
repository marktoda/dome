import { NextResponse } from 'next/server';

// Placeholder for actual DB operations is now replaced by dome-api call
// import { updateMockIntegrationStatus } from '@/lib/integration-mock-db';

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
    const workspaceId = tokenData.workspace_id;
    const owner = tokenData.owner;
    const duplicatedTemplateId = tokenData.duplicated_template_id;


    if (!accessToken || !workspaceId) {
      console.error('Notion access token or workspace_id not found in response:', tokenData);
      return NextResponse.json({ error: 'Access token or workspace_id not found in Notion response' }, { status: 500 });
    }

    // 2. Notion doesn't have a separate "get user" endpoint for OAuth like GitHub.
    // The token response already contains workspace info and bot_id.
    
    // 3. Send integration details to dome-api to be stored by Tsunami
    const userId = 'default-user'; // TODO: Replace with actual user ID from session/auth. This should ideally be obtained from an auth token/session.
    const domeApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (!domeApiBaseUrl) {
      console.error('NEXT_PUBLIC_API_BASE_URL is not set. Cannot store Notion integration.');
      // Handle error appropriately, perhaps redirect with an error message
      const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
      errorRedirectUrl.searchParams.append('oauth_callback', 'true');
      errorRedirectUrl.searchParams.append('platform', 'notion');
      errorRedirectUrl.searchParams.append('status', 'error');
      errorRedirectUrl.searchParams.append('error_message', 'Server configuration error: API base URL missing.');
      return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    }

    const storeIntegrationResponse = await fetch(`${domeApiBaseUrl}/content/notion/oauth/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // TODO: Add Authorization header if dome-api endpoint is protected
        // 'Authorization': `Bearer YOUR_INTERNAL_AUTH_TOKEN_OR_API_KEY_FOR_DOME_API`
      },
      body: JSON.stringify({
        userId, // This needs to be the actual authenticated user's ID
        accessToken,
        workspaceId,
        workspaceName,
        workspaceIcon,
        botId,
        owner,
        duplicatedTemplateId,
      }),
    });

    if (!storeIntegrationResponse.ok) {
      const errorData = await storeIntegrationResponse.json().catch(() => ({ message: 'Failed to store Notion integration and parse error response.' }));
      console.error('Failed to store Notion integration via dome-api:', errorData);
      // Redirect back to frontend with error
      const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
      errorRedirectUrl.searchParams.append('oauth_callback', 'true');
      errorRedirectUrl.searchParams.append('platform', 'notion');
      errorRedirectUrl.searchParams.append('status', 'error');
      errorRedirectUrl.searchParams.append('error_message', `Failed to save Notion integration: ${errorData.message || storeIntegrationResponse.statusText}`);
      return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    }

    const storeResult = await storeIntegrationResponse.json();
    console.log('Notion integration stored via dome-api:', storeResult);
    
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