import { NextResponse } from 'next/server';
import type { IntegrationStatus, IntegrationPlatform } from '@/lib/oauth-types';

// Mock database or state for all integrations
// In a real app, this would come from a database and be user-specific.
const mockUserIntegrationStatuses: Record<string, IntegrationStatus[]> = { // Changed let to const
  'default-user': [ // Using a default user ID for simplicity in mock
    {
      platform: 'github',
      isConnected: false,
    },
    {
      platform: 'notion',
      isConnected: true,
      user: {
        name: 'Toda Notion',
        email: 'toda@example.com',
      },
    },
  ]
};


export async function GET() {
  // In a real app, you'd fetch this based on the authenticated user
  const userId = 'default-user'; // Placeholder for actual user ID
  const userStatuses = mockUserIntegrationStatuses[userId] || [];
  return NextResponse.json(userStatuses);
}

// Helper to get a specific integration status for the mock user
export function getMockIntegrationStatus(platform: IntegrationPlatform, userId: string = 'default-user'): IntegrationStatus | undefined {
  const userStatuses = mockUserIntegrationStatuses[userId];
  if (!userStatuses) {
    return undefined;
  }
  return userStatuses.find(s => s.platform === platform);
}

// Helper function to update mock status for the mock user
export function updateMockIntegrationStatus(
  platform: IntegrationPlatform,
  updates: Partial<IntegrationStatus>,
  userId: string = 'default-user'
): IntegrationStatus | undefined {
  if (!mockUserIntegrationStatuses[userId]) {
    mockUserIntegrationStatuses[userId] = [];
  }

  const userStatuses = mockUserIntegrationStatuses[userId];
  const index = userStatuses.findIndex(s => s.platform === platform);

  if (index !== -1) {
    userStatuses[index] = { ...userStatuses[index], ...updates, platform };
    return userStatuses[index];
  } else {
    // If platform doesn't exist for user, add it (e.g., first time connecting)
    const newStatus: IntegrationStatus = {
      platform,
      isConnected: updates.isConnected !== undefined ? updates.isConnected : false, // Default to false if not specified
      user: updates.user,
      ...updates, // Apply any other updates
    };
    userStatuses.push(newStatus);
    return newStatus;
  }
}