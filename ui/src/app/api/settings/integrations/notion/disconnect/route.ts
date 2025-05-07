import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/app/api/settings/integrations/route';

export async function POST(request: Request) {
  // Simulate successful Notion OAuth disconnection
  const updatedStatus = updateMockIntegrationStatus('notion', {
    isConnected: false,
    user: undefined, // Clear user info
  });

  if (updatedStatus) {
    return NextResponse.json({ success: true, message: 'Notion account disconnected successfully.' });
  } else {
    return NextResponse.json({ success: false, error: 'Failed to disconnect Notion account' }, { status: 500 });
  }
}