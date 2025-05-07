import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/app/api/settings/integrations/route';

export async function GET(request: Request) {
  // Simulate successful Notion OAuth connection
  const updatedStatus = updateMockIntegrationStatus('notion', {
    isConnected: true,
    user: {
      name: 'Mock Notion User',
      email: 'mock.notion@example.com',
    },
  });

  const { searchParams } = new URL(request.url);
  const redirect_uri = searchParams.get('redirect_uri') || '/settings/integrations';
  
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const absoluteRedirectUrl = new URL(redirect_uri, baseUrl).toString();

  if (updatedStatus) {
    return NextResponse.redirect(absoluteRedirectUrl, { status: 302 });
  } else {
    return NextResponse.json({ error: 'Failed to connect Notion account' }, { status: 500 });
  }
}