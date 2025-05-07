import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db';

export async function POST() {
  // Removed unused _request parameter
  // Simulate successful Notion OAuth disconnection
  // In real code, derive userId from the session / auth token.
  const userId = 'default-user';
  const updatedStatuses = updateMockIntegrationStatus(
    userId,
    'notion',
    false, // isConnected: false
    undefined // No user data on disconnect
  );

  if (updatedStatuses) {
    return NextResponse.json({
      success: true,
      message: 'Notion account disconnected successfully.',
    });
  } else {
    return NextResponse.json(
      { success: false, error: 'Failed to disconnect Notion account' },
      { status: 500 },
    );
  }
}

