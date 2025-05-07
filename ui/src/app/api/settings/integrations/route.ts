import { NextResponse } from 'next/server';
import { getMockIntegrationStatuses } from '@/lib/integration-mock-db';

/**
 * GET /api/settings/integrations
 * Returns the integration status list for the authenticated user.
 */
export async function GET() {
  // In real code, derive userId from the session / auth token.
  const userId = 'default-user';
  const statuses = getMockIntegrationStatuses(userId);
  return NextResponse.json(statuses);
}
