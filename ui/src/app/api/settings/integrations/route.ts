import { NextRequest, NextResponse } from 'next/server';
import type { IntegrationStatus } from '@/lib/oauth-types';

/**
 * Extract user ID from JWT token in request cookies.
 * TODO: Replace with actual auth service integration.
 */
function getUserIdFromRequest(req: NextRequest): string | null {
  try {
    // TODO: Implement proper JWT token verification
    // For now, return a placeholder that will be replaced with real auth
    const authToken = req.cookies.get('authToken')?.value;
    if (!authToken) {
      return null;
    }
    
    // Placeholder: In real implementation, decode and verify JWT
    // const payload = jwt.verify(authToken, process.env.JWT_SECRET);
    // return payload.userId;
    
    // Temporary fallback for development
    return 'authenticated-user';
  } catch (error) {
    console.error('Error extracting user ID from request:', error);
    return null;
  }
}

/**
 * Fetch integration statuses from the backend service.
 * TODO: Implement actual API call to tsunami service.
 */
async function fetchIntegrationStatuses(userId: string): Promise<IntegrationStatus[]> {
  // TODO: Make actual API call to tsunami service to get real integration statuses
  // This should query the database for stored OAuth tokens and return connection status
  
  // Placeholder implementation - replace with real backend integration
  const mockStatuses: IntegrationStatus[] = [
    { platform: 'github', isConnected: false },
    { platform: 'notion', isConnected: false },
  ];
  
  console.warn('TODO: Replace with actual backend API call to fetch integration statuses');
  return mockStatuses;
}

/**
 * Handles GET requests to `/api/settings/integrations`.
 * Fetches and returns the current status of all configured integrations for the authenticated user.
 *
 * @param req - The incoming NextRequest object.
 * @returns A NextResponse object containing:
 *   - 200 OK: An array of `IntegrationStatus` objects.
 *   - 401 Unauthorized: If the user is not authenticated.
 *   - 500 Internal Server Error: If an unexpected error occurs.
 */
export async function GET(req: NextRequest) {
  try {
    // Extract user ID from authentication token
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    // Fetch integration statuses from backend
    const statuses = await fetchIntegrationStatuses(userId);

    return NextResponse.json(statuses);
  } catch (error) {
    console.error('Error fetching integration statuses:', error);
    return NextResponse.json({ message: 'Internal Server Error' }, { status: 500 });
  }
}
