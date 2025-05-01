import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { NotionClient, NotionPage, NotionBlock } from '../../../src/providers/notion/client';
import { NotionAuthManager } from '../../../src/providers/notion/auth';
import { ServiceError } from '@dome/common/src/errors';

// Mock performance.now
vi.stubGlobal('performance', {
  now: vi.fn(() => 1000)
});

// Mock the global fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the logger and metrics
vi.mock('@dome/logging', () => ({
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
  getRequestId: vi.fn().mockReturnValue('test-request-id'),
}));

describe('NotionClient', () => {
  const mockApiKey = 'test-api-key';
  let client: NotionClient;
  let mockAuthManager: NotionAuthManager;
  
  beforeEach(() => {
    // Create a mock auth manager
    mockAuthManager = {
      getUserToken: vi.fn(),
      storeUserToken: vi.fn(),
      getAuthUrl: vi.fn(),
      exchangeCodeForToken: vi.fn(),
    } as unknown as NotionAuthManager;
    
    client = new NotionClient(mockApiKey, mockAuthManager);
    vi.clearAllMocks();
    
    // Default successful response mock
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
      headers: new Map([['x-ratelimit-remaining', '100']]),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('authentication', () => {
    it('should create a new client with the provided token', () => {
      const newToken = 'new-token';
      const newClient = client.withToken(newToken);
      
      // Should be a new instance
      expect(newClient).not.toBe(client);
      // Should have the new token
      expect((newClient as any).apiKey).toBe(newToken);
      // Should retain the auth manager
      expect((newClient as any).authManager).toBe(mockAuthManager);
    });

    it('should get token for user from auth manager', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      const mockToken = 'user-token';
      
      (mockAuthManager.getUserToken as Mock).mockResolvedValue(mockToken);
      
      const result = await client.getTokenForUser(userId, workspaceId);
      
      expect(mockAuthManager.getUserToken).toHaveBeenCalledWith(userId, workspaceId);
      expect(result).toBe(mockToken);
    });

    it('should return null when auth manager is not available', async () => {
      const clientWithoutAuth = new NotionClient(mockApiKey);
      const result = await clientWithoutAuth.getTokenForUser('user-123', 'workspace-456');
      
      expect(result).toBeNull();
    });

    it('should create user-specific client when token is available', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      const mockToken = 'user-token';
      
      (mockAuthManager.getUserToken as Mock).mockResolvedValue(mockToken);
      
      const userClient = await client.forUser(userId, workspaceId);
      
      expect(mockAuthManager.getUserToken).toHaveBeenCalledWith(userId, workspaceId);
      expect(userClient).not.toBe(client);
      expect((userClient as any).apiKey).toBe(mockToken);
    });

    it('should return the same client when no user token is found', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-456';
      
      (mockAuthManager.getUserToken as Mock).mockResolvedValue(null);
      
      const userClient = await client.forUser(userId, workspaceId);
      
      expect(mockAuthManager.getUserToken).toHaveBeenCalledWith(userId, workspaceId);
      expect(userClient).toBe(client);
    });
  });

  describe('getUpdatedPages', () => {
    it('should fetch updated pages with proper parameters', async () => {
      const workspaceId = 'workspace-123';
      const cursor = '2023-01-01T00:00:00Z';
      const mockPages = [
        { id: 'page-1', last_edited_time: '2023-01-02T00:00:00Z' },
        { id: 'page-2', last_edited_time: '2023-01-01T12:00:00Z' },
        { id: 'page-3', last_edited_time: '2022-12-31T00:00:00Z' }, // Before cursor
      ];
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: mockPages }),
        headers: new Map(),
      });
      
      const results = await client.getUpdatedPages(workspaceId, cursor);
      
      // Only pages after cursor should be returned
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('page-1');
      expect(results[1].id).toBe('page-2');
      
      // Verify correct API call was made
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/search',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
            'Notion-Version': '2022-06-28',
          }),
          body: expect.any(String),
        })
      );
      
      // Verify request body
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody).toEqual({
        filter: {
          value: 'page',
          property: 'object'
        },
        sort: {
          direction: 'descending',
          timestamp: 'last_edited_time'
        },
        page_size: 100
      });
    });

    it('should return all pages when cursor is null', async () => {
      const workspaceId = 'workspace-123';
      const mockPages = [
        { id: 'page-1', last_edited_time: '2023-01-02T00:00:00Z' },
        { id: 'page-2', last_edited_time: '2023-01-01T12:00:00Z' },
      ];
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: mockPages }),
        headers: new Map(),
      });
      
      const results = await client.getUpdatedPages(workspaceId, null);
      
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('page-1');
      expect(results[1].id).toBe('page-2');
    });

    it('should throw ServiceError on API failure', async () => {
      const workspaceId = 'workspace-123';
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server Error',
        headers: new Map(),
      });
      
      await expect(client.getUpdatedPages(workspaceId, null))
        .rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError on fetch failure', async () => {
      const workspaceId = 'workspace-123';
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      
      await expect(client.getUpdatedPages(workspaceId, null))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('getPage', () => {
    it('should fetch a page by ID and extract title', async () => {
      const pageId = 'page-123';
      const mockPage = {
        id: pageId,
        properties: {
          title: {
            title: [
              { plain_text: 'Test' },
              { plain_text: ' Page' }
            ]
          }
        }
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPage,
        headers: new Map(),
      });
      
      const result = await client.getPage(pageId);
      
      expect(result.id).toBe(pageId);
      expect(result.title).toBe('Test Page');
      
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.notion.com/v1/pages/${pageId}`,
        expect.anything()
      );
    });

    it('should fallback to Name property for title extraction', async () => {
      const pageId = 'page-123';
      const mockPage = {
        id: pageId,
        properties: {
          Name: {
            title: [
              { plain_text: 'Test Page' }
            ]
          }
        }
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPage,
        headers: new Map(),
      });
      
      const result = await client.getPage(pageId);
      
      expect(result.title).toBe('Test Page');
    });

    it('should use fallback title when no title properties exist', async () => {
      const pageId = 'page-123';
      const mockPage = {
        id: pageId,
        properties: {}
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPage,
        headers: new Map(),
      });
      
      const result = await client.getPage(pageId);
      
      expect(result.title).toBe(`Untitled Page (${pageId})`);
    });

    it('should throw ServiceError on API failure', async () => {
      const pageId = 'page-123';
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
        headers: new Map(),
      });
      
      await expect(client.getPage(pageId))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('getPageContent', () => {
    it('should fetch all blocks for a page', async () => {
      const pageId = 'page-123';
      const mockBlocks = [
        { id: 'block-1', type: 'paragraph', has_children: false },
        { id: 'block-2', type: 'heading_1', has_children: true }
      ];
      const mockChildBlocks = [
        { id: 'child-1', type: 'paragraph', has_children: false }
      ];
      
      // Mock first request for parent blocks
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ 
          results: mockBlocks,
          next_cursor: null
        }),
        headers: new Map(),
      });
      
      // Mock request for child blocks of block-2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ 
          results: mockChildBlocks,
          next_cursor: null
        }),
        headers: new Map(),
      });
      
      const result = await client.getPageContent(pageId);
      
      // Should return JSON string of all blocks (parent and children)
      const parsedResult = JSON.parse(result);
      expect(parsedResult.length).toBe(3); // 2 parent blocks + 1 child block
      expect(parsedResult[0].id).toBe('block-1');
      expect(parsedResult[1].id).toBe('block-2');
      expect(parsedResult[2].id).toBe('child-1');
      
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
        expect.anything()
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `https://api.notion.com/v1/blocks/block-2/children?page_size=100`,
        expect.anything()
      );
    });

    it('should handle pagination when fetching blocks', async () => {
      const pageId = 'page-123';
      const mockBlocks1 = [{ id: 'block-1', type: 'paragraph', has_children: false }];
      const mockBlocks2 = [{ id: 'block-2', type: 'paragraph', has_children: false }];
      
      // First page of results
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ 
          results: mockBlocks1,
          next_cursor: 'cursor-123'
        }),
        headers: new Map(),
      });
      
      // Second page of results
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ 
          results: mockBlocks2,
          next_cursor: null
        }),
        headers: new Map(),
      });
      
      const result = await client.getPageContent(pageId);
      
      const parsedResult = JSON.parse(result);
      expect(parsedResult.length).toBe(2);
      expect(parsedResult[0].id).toBe('block-1');
      expect(parsedResult[1].id).toBe('block-2');
      
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
        expect.anything()
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100&start_cursor=cursor-123`,
        expect.anything()
      );
    });

    it('should throw ServiceError on API failure', async () => {
      const pageId = 'page-123';
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server Error',
        headers: new Map(),
      });
      
      await expect(client.getPageContent(pageId))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('getDatabase', () => {
    it('should fetch a database by ID', async () => {
      const databaseId = 'db-123';
      const mockDatabase = {
        id: databaseId,
        title: [{ plain_text: 'Test Database' }],
        properties: { 
          Column1: { type: 'title' }, 
          Column2: { type: 'text' }
        }
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockDatabase,
        headers: new Map(),
      });
      
      const result = await client.getDatabase(databaseId);
      
      expect(result.id).toBe(databaseId);
      expect(result.properties).toEqual(mockDatabase.properties);
      
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.notion.com/v1/databases/${databaseId}`,
        expect.anything()
      );
    });

    it('should throw ServiceError on API failure', async () => {
      const databaseId = 'db-123';
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
        headers: new Map(),
      });
      
      await expect(client.getDatabase(databaseId))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('getWorkspaces', () => {
    it('should fetch all workspaces', async () => {
      const mockWorkspaces = [
        { id: 'workspace-1', name: 'Workspace 1' },
        { id: 'workspace-2', name: 'Workspace 2' }
      ];
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: mockWorkspaces }),
        headers: new Map(),
      });
      
      const result = await client.getWorkspaces();
      
      expect(result).toEqual(mockWorkspaces);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/users',
        expect.anything()
      );
    });

    it('should return empty array when no workspaces exist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}), // No results property
        headers: new Map(),
      });
      
      const result = await client.getWorkspaces();
      
      expect(result).toEqual([]);
    });

    it('should throw ServiceError on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized',
        headers: new Map(),
      });
      
      await expect(client.getWorkspaces())
        .rejects.toThrow(ServiceError);
    });
  });

  describe('error handling and retry logic', () => {
    it('should retry on rate limit (429) responses', async () => {
      const pageId = 'page-123';
      
      // First attempt - rate limited
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Map([['retry-after', '1']]),
        text: async () => 'Rate limited',
      });
      
      // Second attempt - success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: pageId }),
        headers: new Map(),
      });
      
      // Add mock for setTimeout to avoid actually waiting
      vi.useFakeTimers();
      
      const getPagePromise = client.getPage(pageId);
      
      // Fast forward the timer to complete the retry delay
      vi.advanceTimersByTime(1000);
      
      const result = await getPagePromise;
      
      expect(result.id).toBe(pageId);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      
      vi.useRealTimers();
    });

    it('should throw ServiceError after max retries on rate limit', async () => {
      const pageId = 'page-123';
      
      // Set up mocks for multiple rate limit responses
      for (let i = 0; i < 4; i++) { // Original + 3 retries
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Map([['retry-after', '1']]),
          text: async () => 'Rate limited',
        });
      }
      
      vi.useFakeTimers();
      
      const getPagePromise = client.getPage(pageId);
      
      // Fast forward through all retry delays
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(1000);
      }
      
      await expect(getPagePromise).rejects.toThrow(ServiceError);
      expect(mockFetch).toHaveBeenCalledTimes(4); // Original + 3 retries
      
      vi.useRealTimers();
    });

    it('should handle fetch errors and throw ServiceError', async () => {
      const pageId = 'page-123';
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      
      await expect(client.getPage(pageId)).rejects.toThrow(ServiceError);
    });

    it('should handle non-JSON responses and throw ServiceError', async () => {
      const pageId = 'page-123';
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => { throw new Error('Invalid JSON'); },
        text: async () => 'Not JSON',
        headers: new Map(),
      });
      
      await expect(client.getPage(pageId)).rejects.toThrow(ServiceError);
    });
  });
});