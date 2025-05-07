import { NextResponse } from 'next/server';
import { updateMockIntegrationStatus } from '@/lib/integration-mock-db';

export async function GET(request: Request) {
  // Simulate successful GitHub OAuth connection
  // In a real app, you'd handle the OAuth callback here, exchange code for token, fetch user info, etc.
  // In real code, derive userId from the session / auth token.
  const userId = 'default-user';
  const updatedStatuses = updateMockIntegrationStatus(
    userId,
    'github',
    true,
    {
      name: 'Mock GitHub User',
      email: 'mock.github@example.com',
    }
  );

  // For a real OAuth flow, you'd typically redirect the user back to the settings page
  // or a page indicating success.
  // The redirect URL should be absolute.
  const { searchParams } = new URL(request.url);
  const redirect_uri = searchParams.get('redirect_uri') || '/settings/integrations';

  // Construct the base URL dynamically or from an environment variable
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const absoluteRedirectUrl = new URL(redirect_uri, baseUrl).toString();

  if (updatedStatuses) {
    return NextResponse.redirect(absoluteRedirectUrl, { status: 302 });
  } else {
    // Handle case where status update might fail, though unlikely in this mock
    return NextResponse.json({ error: 'Failed to connect GitHub account' }, { status: 500 });
  }
}
