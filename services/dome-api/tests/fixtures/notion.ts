/**
 * Test fixtures for Notion controller and API tests
 */

/**
 * Mock Notion workspace registration data
 */
export const mockNotionWorkspaceData = {
  workspaceId: 'workspace-123',
  userId: 'user-123',
  cadence: 'PT2H', // 2 hours
};

/**
 * Mock Notion workspace data without cadence (to test defaults)
 */
export const mockNotionWorkspaceDataNoCadence = {
  workspaceId: 'workspace-123',
  userId: 'user-123',
};

/**
 * Mock Notion workspace with invalid data (for validation tests)
 */
export const mockNotionWorkspaceInvalidData = {
  // Missing required workspaceId
  userId: 'user-123',
  cadence: 'PT1H',
};

/**
 * Mock Notion workspace registration response
 */
export const mockNotionWorkspaceResponse = {
  id: 'sync-123',
  resourceId: 'workspace-123',
  wasInitialised: true,
};

/**
 * Mock Notion workspace history response
 */
export const mockNotionWorkspaceHistory = {
  workspaceId: 'workspace-123',
  resourceId: 'workspace-123',
  history: [
    {
      id: 'history-1',
      timestamp: 1617235678000,
      status: 'completed',
      itemCount: 42,
      error: null,
    },
    {
      id: 'history-2',
      timestamp: 1617235679000,
      status: 'completed',
      itemCount: 17,
      error: null,
    },
  ],
};

/**
 * Mock Notion OAuth configuration data
 */
export const mockNotionOAuthConfigData = {
  code: 'oauth-code-123',
  redirectUri: 'https://example.com/callback',
  userId: 'user-123',
};

/**
 * Mock Notion OAuth configuration data with invalid redirect URI (for validation tests)
 */
export const mockNotionOAuthConfigInvalidData = {
  code: 'oauth-code-123',
  redirectUri: 'invalid-url', // Not a valid URL
  userId: 'user-123',
};

/**
 * Mock Notion OAuth URL request data
 */
export const mockNotionOAuthUrlData = {
  redirectUri: 'https://example.com/callback',
  state: 'random-state-123',
};

/**
 * Mock Notion OAuth URL request data without state
 */
export const mockNotionOAuthUrlDataNoState = {
  redirectUri: 'https://example.com/callback',
};

/**
 * Mock Notion OAuth URL response
 */
export const mockNotionOAuthUrlResponse = {
  url: 'https://api.notion.com/v1/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&response_type=code&state=random-state-123',
};

/**
 * Mock error response from Tsunami service
 */
export const mockTsunamiServiceError = {
  message: 'Failed to register workspace',
  code: 'REGISTRATION_ERROR',
  status: 503,
};
