import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotionAuthManager } from '../../../src/providers/notion/auth';
import { ServiceError } from '@dome/common/src/errors';

// Mock the global fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock btoa for Basic auth
global.btoa = vi.fn(str => Buffer.from(str).toString('base64'));

// Mock the logger
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  metrics: {
    timing: vi.fn(),
    increment: vi.fn(),
  },
}));

// Mock performance.now
vi.stubGlobal('performance', {
  now: vi.fn(() => 1000),
});

describe('NotionAuthManager', () => {
  const mockEnv = {
    NOTION_CLIENT_ID: 'test-client-id',
    NOTION_CLIENT_SECRET: 'test-client-secret',
    NOTION_REDIRECT_URI: 'https://example.com/callback',
  };

  let authManager: NotionAuthManager;

  beforeEach(() => {
    authManager = new NotionAuthManager(mockEnv as any);
    vi.clearAllMocks();

    // Default successful response for token exchange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'test-access-token',
        workspace_id: 'test-workspace-id',
        workspace_name: 'Test Workspace',
        workspace_icon: 'icon-url',
        bot_id: 'test-bot-id',
        owner: {
          type: 'user',
          user: {
            id: 'test-user-id',
            name: 'Test User',
            avatar_url: 'avatar-url',
          },
        },
      }),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getAuthUrl', () => {
    it('should generate valid Notion OAuth URL', () => {
      const state = 'random-state-string';
      const url = authManager.getAuthUrl(state);

      // Should be a valid URL
      expect(() => new URL(url)).not.toThrow();

      // Should include all required parameters
      const parsedUrl = new URL(url);
      expect(parsedUrl.origin + parsedUrl.pathname).toBe(
        'https://api.notion.com/v1/oauth/authorize',
      );
      expect(parsedUrl.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsedUrl.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
      expect(parsedUrl.searchParams.get('response_type')).toBe('code');
      expect(parsedUrl.searchParams.get('owner')).toBe('user');
      expect(parsedUrl.searchParams.get('state')).toBe(state);
    });
  });

  describe('exchangeCodeForToken', () => {
    it('should exchange authorization code for access token', async () => {
      const code = 'test-auth-code';
      const result = await authManager.exchangeCodeForToken(code);

      // Should make POST request to token endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Basic ${btoa('test-client-id:test-client-secret')}`,
            'Content-Type': 'application/json',
          }),
          body: expect.any(String),
        }),
      );

      // Verify request body
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody).toEqual({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://example.com/callback',
      });

      // Verify returned token data
      expect(result).toEqual({
        accessToken: 'test-access-token',
        workspaceId: 'test-workspace-id',
        workspaceName: 'Test Workspace',
        botId: 'test-bot-id',
      });
    });

    it('should throw ServiceError on API error response', async () => {
      const code = 'invalid-code';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      });

      await expect(authManager.exchangeCodeForToken(code)).rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError on network error', async () => {
      const code = 'test-code';

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(authManager.exchangeCodeForToken(code)).rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError on invalid JSON response', async () => {
      const code = 'test-code';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(authManager.exchangeCodeForToken(code)).rejects.toThrow(ServiceError);
    });
  });

  describe('token storage and retrieval', () => {
    it('should store and retrieve user tokens', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      const token = 'access-token-789';

      // Store token
      await authManager.storeUserToken(userId, workspaceId, token);

      // Retrieve token
      const retrievedToken = await authManager.getUserToken(userId, workspaceId);

      expect(retrievedToken).toBe(token);
    });

    it('should return null for non-existent tokens', async () => {
      const userId = 'non-existent-user';
      const workspaceId = 'non-existent-workspace';

      const token = await authManager.getUserToken(userId, workspaceId);

      expect(token).toBeNull();
    });

    it('should use correct storage key format', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      const token = 'access-token-789';

      // Store token
      await authManager.storeUserToken(userId, workspaceId, token);

      // Access internal tokenStore directly
      const tokenStore = (authManager as any).tokenStore;
      const key = `notion_token:${userId}:${workspaceId}`;

      expect(tokenStore.get(key)).toBe(token);
    });

    it('should handle errors in token storage', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      const token = 'access-token-789';

      // Mock a failure in the Map.set method
      const mockTokenStore = {
        set: vi.fn().mockImplementation(() => {
          throw new Error('Storage error');
        }),
        get: vi.fn(),
      };
      (authManager as any).tokenStore = mockTokenStore;

      await expect(authManager.storeUserToken(userId, workspaceId, token)).rejects.toThrow(
        ServiceError,
      );
    });

    it('should handle errors in token retrieval', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';

      // Mock a failure in the Map.get method
      const mockTokenStore = {
        set: vi.fn(),
        get: vi.fn().mockImplementation(() => {
          throw new Error('Retrieval error');
        }),
      };
      (authManager as any).tokenStore = mockTokenStore;

      await expect(authManager.getUserToken(userId, workspaceId)).rejects.toThrow(ServiceError);
    });
  });

  describe('initialization', () => {
    it('should handle incomplete environment configuration', () => {
      // Create auth manager with missing environment variables
      const incompleteEnv = {
        // Missing NOTION_CLIENT_ID
        NOTION_CLIENT_SECRET: 'test-client-secret',
        NOTION_REDIRECT_URI: 'https://example.com/callback',
      };

      const manager = new NotionAuthManager(incompleteEnv as any);

      // Should still initialize
      expect(manager).toBeDefined();

      // But auth URL should use empty client ID
      const url = manager.getAuthUrl('test-state');
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('client_id')).toBe('');
    });
  });
});
