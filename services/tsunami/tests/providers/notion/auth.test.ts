import { describe, it, expect, vi, beforeEach, afterEach, Mocked } from 'vitest'; // Added Mocked
import { NotionAuthManager } from '../../../src/providers/notion/auth';
import { ServiceError } from '@dome/common/src/errors';
import { TokenService } from '../../../src/services/tokenService'; // Import TokenService
import type { NotionOAuthDetails } from '../../../src/client/types'; // Import NotionOAuthDetails

// Mock TokenService
vi.mock('../../../src/services/tokenService');

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
    SYNC_PLAN: {} as any, // Mock D1 binding for TokenService
  };

  let authManager: NotionAuthManager;
  let mockTokenServiceInstance: Mocked<TokenService>; // Changed to Mocked

  beforeEach(() => {
    // Reset mocks for TokenService before each test
    // This ensures that TokenService is mocked correctly for each test case.
    vi.mocked(TokenService).mockClear();
    mockTokenServiceInstance = new TokenService(mockEnv.SYNC_PLAN) as Mocked<TokenService>; // Changed to Mocked
    vi.mocked(TokenService).mockImplementation(() => mockTokenServiceInstance);

    authManager = new NotionAuthManager(mockEnv as any);
    vi.clearAllMocks(); // Clear other mocks like fetch

    // Re-mock TokenService methods for this instance if needed, or rely on class mock
    mockTokenServiceInstance.storeNotionToken = vi
      .fn()
      .mockResolvedValue({
        success: true,
        tokenId: 'new-token-id',
        workspaceId: 'test-workspace-id',
      });
    mockTokenServiceInstance.getToken = vi.fn().mockResolvedValue(null);

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

      // Verify returned token data (now returns full object)
      expect(result).toEqual(
        expect.objectContaining({
          access_token: 'test-access-token',
          workspace_id: 'test-workspace-id',
          // ... other fields from mockFetch response
        }),
      );
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

  describe('token storage and retrieval via TokenService', () => {
    const mockNotionTokenResponse = {
      access_token: 'test-access-token-789',
      workspace_id: 'workspace-456',
      workspace_name: 'Test Workspace',
      workspace_icon: 'icon-url',
      bot_id: 'bot-789',
      owner: {
        type: 'user',
        user: { id: 'user-123', name: 'Test User', avatar_url: 'avatar-url' },
      },
    };

    it('should store user integration details via TokenService', async () => {
      const userId = 'user-123';

      await authManager.storeUserNotionIntegration(userId, mockNotionTokenResponse);

      expect(mockTokenServiceInstance.storeNotionToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          accessToken: mockNotionTokenResponse.access_token,
          workspaceId: mockNotionTokenResponse.workspace_id,
          botId: mockNotionTokenResponse.bot_id,
        }),
      );
    });

    it('should retrieve user tokens via TokenService and return access_token', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      const storedTokenRecord = {
        id: 'token-id',
        userId,
        provider: 'notion',
        providerAccountId: 'bot-789',
        accessToken: 'retrieved-access-token',
        providerWorkspaceId: workspaceId,
      };
      mockTokenServiceInstance.getToken = vi.fn().mockResolvedValue(storedTokenRecord as any);

      const retrievedToken = await authManager.getUserToken(userId, workspaceId);
      expect(mockTokenServiceInstance.getToken).toHaveBeenCalledWith(userId, 'notion', workspaceId);
      expect(retrievedToken).toBe('retrieved-access-token');
    });

    it('should return null if TokenService does not find a token', async () => {
      const userId = 'non-existent-user';
      const workspaceId = 'non-existent-workspace';
      mockTokenServiceInstance.getToken = vi.fn().mockResolvedValue(null);

      const token = await authManager.getUserToken(userId, workspaceId);
      expect(mockTokenServiceInstance.getToken).toHaveBeenCalledWith(userId, 'notion', workspaceId);
      expect(token).toBeNull();
    });

    it('should handle errors from TokenService during token storage', async () => {
      const userId = 'user-123';
      mockTokenServiceInstance.storeNotionToken = vi
        .fn()
        .mockRejectedValue(new Error('TokenService storage error'));

      await expect(
        authManager.storeUserNotionIntegration(userId, mockNotionTokenResponse),
      ).rejects.toThrow(ServiceError);
    });

    it('should handle errors from TokenService during token retrieval', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      mockTokenServiceInstance.getToken = vi
        .fn()
        .mockRejectedValue(new Error('TokenService retrieval error'));

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
