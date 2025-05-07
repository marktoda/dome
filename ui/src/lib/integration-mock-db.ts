import type { IntegrationStatus, IntegrationPlatform } from '@/lib/oauth-types';

/**
 * Mock database – replace with a real persistence layer when ready.
 */
export const mockUserIntegrationStatuses: Record<string, IntegrationStatus[]> = {
  'default-user': [
    { platform: 'github', isConnected: false },
    {
      platform: 'notion',
      isConnected: true,
      user: { name: 'Toda Notion', email: 'toda@example.com' },
    },
  ],
};

/**
 * Updates the mock integration status for a given platform and user.
 * In a real application, this would interact with a database.
 */
export function updateMockIntegrationStatus(
  userId: string,
  platform: IntegrationPlatform,
  isConnected: boolean,
  userData?: { name?: string; email?: string; username?: string; profileUrl?: string; } // Updated to include new optional fields
): IntegrationStatus[] {
  if (!mockUserIntegrationStatuses[userId]) {
    mockUserIntegrationStatuses[userId] = [];
  }

  const platformStatus = mockUserIntegrationStatuses[userId].find(
    (status) => status.platform === platform
  );

  if (platformStatus) {
    platformStatus.isConnected = isConnected;
    if (isConnected && userData) {
      platformStatus.user = userData;
    } else if (!isConnected) {
      delete platformStatus.user;
      // delete platformStatus.details; // Property 'details' does not exist on type 'IntegrationStatus'.
    }
  } else {
    const newStatus: IntegrationStatus = { platform, isConnected };
    if (isConnected && userData) {
      newStatus.user = userData;
    }
    mockUserIntegrationStatuses[userId].push(newStatus);
  }
  return mockUserIntegrationStatuses[userId];
}

/**
 * Retrieves the mock integration statuses for a given user.
 */
export function getMockIntegrationStatuses(userId: string): IntegrationStatus[] {
  return mockUserIntegrationStatuses[userId] ?? [];
}