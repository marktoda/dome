import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db'; // Mock data source
// import { verifyAuth } from '@/lib/auth'; // Example: Import your actual auth verification function
// import apiClient from '@/lib/api'; // Example: Import if calling another backend service

/**
 * Handles POST requests to `/api/settings/integrations/notion/disconnect`.
 * Simulates disconnecting the Notion integration for the authenticated user.
 *
 * @param req - The incoming NextRequest object.
 * @returns A NextResponse object with:
 *   - 200 OK: Success message on successful (mock) disconnection.
 *   - 401 Unauthorized: If the user is not authenticated (in a real implementation).
 *   - 500 Internal Server Error: If the (mock) update fails or an unexpected error occurs.
 *
 * @security **Note:** This implementation currently uses a **mock data source** (`updateMockIntegrationStatus`)
 *           and does not perform real authentication or backend calls to revoke tokens/data.
 *           Replace mock logic with actual authentication and calls to your backend API
 *           (e.g., to delete stored tokens). Notion does not currently provide an API endpoint
 *           for applications to programmatically revoke OAuth grants. Users must revoke access
 *           manually in their Notion settings. Your backend should still remove the stored token.
 */
export async function POST(req: NextRequest) {
  // Add req parameter
  console.error(
    '⚠️ Using MOCK /api/settings/integrations/notion/disconnect endpoint! Replace with actual implementation. ⚠️',
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
    console.error(`Processing disconnect request for Notion for user: ${userId}`);
    // --- !!! MOCK AUTHENTICATION END !!! ---

    // --- !!! MOCK DISCONNECT LOGIC START !!! ---
    // In a real app:
    // 1. Call your backend API to delete the stored token and integration link for the user.
    //    Example: await apiClient.post('/content/notion/oauth/revoke', { platform: 'notion' }); // Assuming backend handles user context
    // 2. Note: Notion does not provide an API to revoke the grant programmatically from the app side.

    // Simulate updating the status in the mock DB
    const success = updateMockIntegrationStatus(
      userId,
      'notion',
      false, // isConnected: false
      undefined, // Clear user data
    );
    // --- !!! MOCK DISCONNECT LOGIC END !!! ---

    if (success) {
      console.error(`Mock disconnect successful for Notion for user: ${userId}`);
      return NextResponse.json({
        success: true,
        message: 'Notion account disconnected successfully.',
      });
    } else {
      console.error(`Mock disconnect failed for Notion for user: ${userId}`);
      // Handle case where mock status update might fail
      return NextResponse.json(
        { success: false, message: 'Failed to update mock disconnection status.' },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('Error during Notion disconnect:', error);
    return NextResponse.json({ success: false, message: 'Internal Server Error' }, { status: 500 });
  }
}
