import { NextRequest, NextResponse } from 'next/server';

/**
 * Extract user ID from JWT token in request cookies.
 * TODO: Replace with actual auth service integration.
 */
function getUserIdFromRequest(req: NextRequest): string | null {
  try {
    // TODO: Implement proper JWT token verification
    const authToken = req.cookies.get('authToken')?.value;
    if (!authToken) {
      return null;
    }
    
    // Placeholder: In real implementation, decode and verify JWT
    return 'authenticated-user';
  } catch (error) {
    console.error('Error extracting user ID from request:', error);
    return null;
  }
}

/**
 * Disconnect Notion integration by removing stored data.
 * Note: Notion does not provide an API to revoke OAuth grants programmatically.
 * TODO: Implement actual backend API calls.
 */
async function disconnectNotionIntegration(userId: string): Promise<{ success: boolean; message: string }> {
  try {
    // TODO: Implement actual disconnection logic:
    // 1. Delete stored Notion token and integration data from tsunami service database
    // 2. Note: Notion doesn't support programmatic OAuth revocation - users must manually revoke in Notion settings
    // 3. Return success status
    
    console.warn('TODO: Implement actual Notion disconnection via tsunami service API');
    
    // Placeholder implementation
    return {
      success: true,
      message: 'Notion account disconnected successfully. Note: To fully revoke access, please manually remove this app from your Notion settings.',
    };
  } catch (error) {
    console.error('Error disconnecting Notion integration:', error);
    return {
      success: false,
      message: 'Failed to disconnect Notion integration.',
    };
  }
}

/**
 * Handles POST requests to `/api/settings/integrations/notion/disconnect`.
 * Disconnects the Notion integration for the authenticated user.
 *
 * @param req - The incoming NextRequest object.
 * @returns A NextResponse object with:
 *   - 200 OK: Success message on successful disconnection.
 *   - 401 Unauthorized: If the user is not authenticated.
 *   - 500 Internal Server Error: If the disconnection fails or an unexpected error occurs.
 */
export async function POST(req: NextRequest) {
  try {
    // Extract user ID from authentication token
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    // Disconnect the Notion integration
    const result = await disconnectNotionIntegration(userId);

    return NextResponse.json(result, { 
      status: result.success ? 200 : 500 
    });
  } catch (error) {
    console.error('Error during Notion disconnect:', error);
    return NextResponse.json({ 
      success: false, 
      message: 'Internal Server Error' 
    }, { status: 500 });
  }
}
