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
 * Disconnect GitHub integration by revoking tokens and removing stored data.
 * TODO: Implement actual backend API calls.
 */
async function disconnectGitHubIntegration(userId: string): Promise<{ success: boolean; message: string }> {
  try {
    // TODO: Implement actual disconnection logic:
    // 1. Fetch stored GitHub access token for this user
    // 2. Call GitHub API to revoke the application grant (optional but recommended)
    // 3. Delete stored token and integration data from tsunami service database
    // 4. Return success status
    
    console.warn('TODO: Implement actual GitHub disconnection via tsunami service API');
    
    // Placeholder implementation
    return {
      success: true,
      message: 'GitHub account disconnected successfully.',
    };
  } catch (error) {
    console.error('Error disconnecting GitHub integration:', error);
    return {
      success: false,
      message: 'Failed to disconnect GitHub integration.',
    };
  }
}

/**
 * Handles POST requests to `/api/settings/integrations/github/disconnect`.
 * Disconnects the GitHub integration for the authenticated user.
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

    // Disconnect the GitHub integration
    const result = await disconnectGitHubIntegration(userId);

    return NextResponse.json(result, { 
      status: result.success ? 200 : 500 
    });
  } catch (error) {
    console.error('Error during GitHub disconnect:', error);
    return NextResponse.json({ 
      success: false, 
      message: 'Internal Server Error' 
    }, { status: 500 });
  }
}
