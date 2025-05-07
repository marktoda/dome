import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db';

export async function POST() {
  // Removed unused _request parameter
  // Simulate successful GitHub OAuth disconnection
  // In a real app, you'd invalidate tokens, remove user data related to the integration, etc.
  // In real code, derive userId from the session / auth token.
  const userId = 'default-user';
  const updatedStatuses = updateMockIntegrationStatus(
    userId,
    'github',
    false, // isConnected: false
    undefined // No user data on disconnect
  );

  if (updatedStatuses) {
    return NextResponse.json({
      success: true,
      message: 'GitHub account disconnected successfully.',
    });
  } else {
    // Handle case where status update might fail
    return NextResponse.json(
      { success: false, error: 'Failed to disconnect GitHub account' },
      { status: 500 },
    );
  }
}
