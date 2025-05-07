import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/app/api/settings/integrations/route';

export async function POST(_request: Request) { // Prefixed unused request parameter
  // Simulate successful GitHub OAuth disconnection
  // In a real app, you'd invalidate tokens, remove user data related to the integration, etc.
  const updatedStatus = updateMockIntegrationStatus('github', {
    isConnected: false,
    user: undefined, // Clear user info
  });

  if (updatedStatus) {
    return NextResponse.json({ success: true, message: 'GitHub account disconnected successfully.' });
  } else {
    // Handle case where status update might fail
    return NextResponse.json({ success: false, error: 'Failed to disconnect GitHub account' }, { status: 500 });
  }
}