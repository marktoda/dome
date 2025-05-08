import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { cookies } from 'next/headers';

/**
 * Handles the GET request for the Notion OAuth callback (`/api/settings/integrations/notion/callback`).
 * This route is hit after the user authorizes the application on Notion.
 *
 * Flow:
 * 1. Extracts the authorization `code`, `state`, and potential `error` from the query parameters.
 * 2. Handles any errors returned directly from Notion.
 * 3. **(Security TODO)** Verifies the received `state` against a stored value to prevent CSRF.
 * 4. Exchanges the `code` for a Notion access token using client ID/secret (via Basic Auth).
 * 5. Extracts relevant workspace and bot information from the token response.
 * 6. Forwards the access token and workspace details to the backend API (`/content/notion/oauth/store`)
 *    along with the user's application authentication token (from cookie) for storage.
 * 7. Redirects the user back to the frontend settings page (or original path stored in state),
 *    appending status parameters (`oauth_callback`, `platform`, `status`, `error_message`).
 *
 * @param request - The incoming NextRequest object.
 * @returns A NextResponse object, typically a redirect (302) back to the frontend settings page.
 *          Redirects include query parameters indicating the success or failure of the OAuth flow.
 *          Returns JSON errors (400, 500) only for initial validation or configuration issues.
 */
export async function GET(request: NextRequest) { // Changed type to NextRequest
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateFromNotion = searchParams.get('state');
  const error = searchParams.get('error'); // Notion might return an error parameter

  // --- Determine Base URL and Redirect Path ---
  // It's better to determine these early for consistent error redirection.
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` || 'http://localhost:3000';
  const [_originalStateValue, encodedClientRedirectPath] = stateFromNotion?.split('|') || [null, null];
  const clientFinalRedirectPath = encodedClientRedirectPath ? decodeURIComponent(encodedClientRedirectPath) : '/settings/integrations';
  // --- End Base URL ---

  // --- 1. Handle Errors from Notion ---
  if (error) {
    console.error('Notion OAuth callback returned an error:', error);
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'notion');
    errorRedirectUrl.searchParams.set('status', 'error');
    errorRedirectUrl.searchParams.set('error_message', `Notion authorization failed: ${error}`);
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
  }

  // --- 2. Validate Parameters ---
  if (!code || !stateFromNotion) {
    console.error('Notion callback error: Missing code or state parameter.');
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'notion');
    errorRedirectUrl.searchParams.set('status', 'error');
    errorRedirectUrl.searchParams.set('error_message', 'Invalid callback parameters from Notion.');
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    // return NextResponse.json({ error: 'Missing code or state from Notion' }, { status: 400 });
  }

  // --- 3. State Verification (CSRF Protection - Simplified) ---
  // !!! SECURITY TODO: Implement proper state verification (see GitHub callback comments) !!!
  console.log(`Notion callback state received. Extracted redirect path: ${clientFinalRedirectPath}`);
  // --- End State Verification ---

  // --- Configuration Check ---
  const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
  const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
  const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL; // Backend API

  if (!NOTION_CLIENT_ID || !NOTION_CLIENT_SECRET || !DOME_API_URL) {
    console.error('CRITICAL: Missing required environment variables for Notion OAuth callback (NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, NEXT_PUBLIC_API_BASE_URL).');
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'notion');
    errorRedirectUrl.searchParams.set('status', 'error');
    errorRedirectUrl.searchParams.set('error_message', 'Server configuration error preventing Notion connection.');
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
    // return NextResponse.json({ error: 'Server configuration error for Notion OAuth.' }, { status: 500 });
  }

  const redirect_uri_for_token_exchange = new URL('/api/settings/integrations/notion/callback', appBaseUrl).toString();
  // Basic Auth header required by Notion for token exchange
  const authHeader = `Basic ${Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64')}`;
  // --- End Configuration Check ---

  try {
    // --- 4. Exchange Code for Access Token ---
    console.log('Exchanging Notion code for access token...');
    const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authHeader, // Basic Auth
        'Notion-Version': '2022-06-28', // Specify Notion API version
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect_uri_for_token_exchange,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({ message: 'Failed to parse Notion token error response.' }));
      console.error('Notion token exchange failed:', tokenResponse.status, errorData);
      throw new Error(`Notion token exchange failed: ${errorData.error_description || errorData.message || tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const workspaceId = tokenData.workspace_id;

    if (!accessToken || !workspaceId) {
      console.error('Notion access token or workspace_id not found in response:', tokenData);
      throw new Error('Access token or workspace_id not found in Notion response.');
    }
    console.log(`Notion access token obtained successfully for workspace: ${workspaceId}`);
    // --- End Token Exchange ---

    // --- 5. Store Integration Details via Backend API ---
    console.log('Storing Notion integration details via backend API...');
    const apiHeaders = new Headers({ 'Content-Type': 'application/json' });
    const cookieStore = await cookies(); // Keep await
    const authTokenCookie = cookieStore.get('auth_token'); // Ensure correct cookie name

    if (!authTokenCookie?.value) {
      console.error('Authentication token cookie not found. Cannot store Notion integration.');
      throw new Error('User authentication token not found.');
    }
    apiHeaders.append('Authorization', `Bearer ${authTokenCookie.value}`);

    const storeIntegrationResponse = await fetch(`${DOME_API_URL}/content/notion/oauth/store`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        // Pass all relevant data obtained from Notion token exchange
        accessToken,
        workspaceId,
        workspaceName: tokenData.workspace_name,
        workspaceIcon: tokenData.workspace_icon,
        botId: tokenData.bot_id,
        owner: tokenData.owner, // Contains user info if scope allows
        duplicatedTemplateId: tokenData.duplicated_template_id, // If template duplication was used
      }),
    });

    if (!storeIntegrationResponse.ok) {
      const errorData = await storeIntegrationResponse.json().catch(() => ({ message: 'Failed to parse backend storage error response.' }));
      console.error('Failed to store Notion integration via backend API:', storeIntegrationResponse.status, errorData);
      throw new Error(`Failed to save Notion integration: ${errorData.message || storeIntegrationResponse.statusText}`);
    }

    const storeResult = await storeIntegrationResponse.json();
    console.log('Notion integration stored successfully via backend API:', storeResult);
    // --- End Integration Storage ---

    // --- 6. Redirect User Back to Frontend (Success) ---
    const finalRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    finalRedirectUrl.searchParams.set('oauth_callback', 'true');
    finalRedirectUrl.searchParams.set('platform', 'notion');
    finalRedirectUrl.searchParams.set('status', 'success');
    console.log(`Redirecting user to success URL: ${finalRedirectUrl.toString()}`);
    return NextResponse.redirect(finalRedirectUrl.toString(), { status: 302 });

  } catch (error) {
    // --- Error Handling & Redirect (Failure) ---
    console.error('Notion OAuth callback processing error:', error);
    const errorRedirectUrl = new URL(clientFinalRedirectPath, appBaseUrl);
    errorRedirectUrl.searchParams.set('oauth_callback', 'true');
    errorRedirectUrl.searchParams.set('platform', 'notion');
    errorRedirectUrl.searchParams.set('status', 'error');
    const errorMessage = (error instanceof Error) ? error.message : 'An unknown error occurred during Notion connection.';
    errorRedirectUrl.searchParams.set('error_message', errorMessage);
    console.log(`Redirecting user to error URL: ${errorRedirectUrl.toString()}`);
    return NextResponse.redirect(errorRedirectUrl.toString(), { status: 302 });
  }
}