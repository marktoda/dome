import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db'; // Mock data source
// import { verifyAuth } from '@/lib/auth'; // Example: Import your actual auth verification function
// import apiClient from '@/lib/api'; // Example: Import if calling another backend service

/**
 * Handles POST requests to `/api/settings/integrations/github/disconnect`.
 * Simulates disconnecting the GitHub integration for the authenticated user.
 *
 * @param req - The incoming NextRequest object.
 * @returns A NextResponse object with:
 *   - 200 OK: Success message on successful (mock) disconnection.
 *   - 401 Unauthorized: If the user is not authenticated (in a real implementation).
 *   - 500 Internal Server Error: If the (mock) update fails or an unexpected error occurs.
 *
 * @security **Note:** This implementation currently uses a **mock data source** (`updateMockIntegrationStatus`)
 *           and does not perform real authentication or backend calls to revoke tokens/data.
 *           Replace mock logic with actual authentication, calls to your backend API
 *           (e.g., to delete stored tokens), and potentially calls to GitHub's API to revoke the grant.
 */
export async function POST(req: NextRequest) {
  // Add req parameter
  console.warn(
    '⚠️ Using MOCK /api/settings/integrations/github/disconnect endpoint! Replace with actual implementation. ⚠️',
  );
  try {
    // --- !!! MOCK AUTHENTICATION START !!! ---
    // In a real application, verify the user's session/token here.
    // Example:
    // const authResult = await verifyAuth(req);
    // if (!authResult.authenticated || !authResult.userId) {
    //   return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    // }
    // const userId = authResult.userId;
    const userId = 'default-user'; // Hardcoded mock user ID
    console.log(`Processing disconnect request for GitHub for user: ${userId}`);
    // --- !!! MOCK AUTHENTICATION END !!! ---

    // --- !!! MOCK DISCONNECT LOGIC START !!! ---
    // In a real app:
    // 1. Get the stored access token for this user and integration.
    // 2. Optionally, call GitHub's API to revoke the application grant using the token.
    //    (DELETE https://api.github.com/applications/{client_id}/grant - requires Basic Auth with client_id:client_secret)
    // 3. Call your backend API to delete the stored token and integration link for the user.
    //    Example: await apiClient.post('/content/github/oauth/revoke', { platform: 'github' }); // Assuming backend handles user context

    // Simulate updating the status in the mock DB
    const success = updateMockIntegrationStatus(
      userId,
      'github',
      false, // isConnected: false
      undefined, // Clear user data
    );
    // --- !!! MOCK DISCONNECT LOGIC END !!! ---

    if (success) {
      console.log(`Mock disconnect successful for GitHub for user: ${userId}`);
      return NextResponse.json({
        success: true,
        message: 'GitHub account disconnected successfully.',
      });
    } else {
      console.error(`Mock disconnect failed for GitHub for user: ${userId}`);
      // Handle case where mock status update might fail (e.g., user not found in mock DB)
      return NextResponse.json(
        { success: false, message: 'Failed to update mock disconnection status.' },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('Error during GitHub disconnect:', error);
    return NextResponse.json({ success: false, message: 'Internal Server Error' }, { status: 500 });
  }
}
