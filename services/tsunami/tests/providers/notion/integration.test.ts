import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotionClient } from '../../../src/providers/notion/client';
import { NotionAuthManager } from '../../../src/providers/notion/auth';
import * as notionUtils from '../../../src/providers/notion/utils';
import { ServiceError } from '@dome/common/src/errors';

// Mock external dependencies
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
  getRequestId: vi.fn().mockReturnValue('test-request-id'),
}));

// Mock performance.now
vi.stubGlobal('performance', {
  now: vi.fn(() => 1000)
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Assuming we have a provider class that orchestrates the integration
// If this class doesn't exist, the test can still serve as a blueprint for how integration should work
class NotionProvider {
  private client: NotionClient;
  private authManager: NotionAuthManager;
  
  constructor(client: NotionClient, authManager: NotionAuthManager) {
    this.client = client;
    this.authManager = authManager;
  }
  
  async registerWorkspace(code: string, userId: string) {
    const tokenData = await this.authManager.exchangeCodeForToken(code);
    await this.authManager.storeUserToken(userId, tokenData.workspaceId, tokenData.accessToken);
    return tokenData;
  }
  
  async syncWorkspace(userId: string, workspaceId: string, cursor: string | null) {
    const client = await this.client.forUser(userId, workspaceId);
    const pages = await client.getUpdatedPages(workspaceId, cursor);
    
    const results = [];
    
    for (const page of pages) {
      try {
        // Skip pages that should be ignored
        if (notionUtils.shouldIgnorePage(page)) {
          continue;
        }
        
        // Get content
        const content = await client.getPageContent(page.id);
        
        // Create metadata
        const metadata = notionUtils.createNotionMetadata(
          workspaceId,
          page.id,
          page.last_edited_time,
          page.title,
          Buffer.byteLength(content, 'utf-8')
        );
        
        results.push({
          id: page.id,
          title: page.title,
          content,
          metadata
        });
      } catch (error) {
        // Log and continue with next page
        console.error(`Error processing page ${page.id}:`, error);
        
        // Add to results as an error for tracking
        results.push({
          id: page.id,
          title: page.title || `Untitled (${page.id})`,
          error: error instanceof Error ? error.message : String(error),
          metadata: notionUtils.createNotionMetadata(
            workspaceId,
            page.id,
            page.last_edited_time,
            page.title || `Untitled (${page.id})`,
            0
          )
        });
      }
    }
    
    return {
      results,
      cursor: pages.length > 0 ? pages[0].last_edited_time : cursor
    };
  }
}

describe('Notion Integration', () => {
  const apiKey = 'test-api-key';
  const mockEnv = {
    NOTION_CLIENT_ID: 'test-client-id',
    NOTION_CLIENT_SECRET: 'test-client-secret',
    NOTION_REDIRECT_URI: 'https://example.com/callback'
  };

  let client: NotionClient;
  let authManager: NotionAuthManager;
  let provider: NotionProvider;
  
  beforeEach(() => {
    authManager = new NotionAuthManager(mockEnv as any);
    client = new NotionClient(apiKey, authManager);
    provider = new NotionProvider(client, authManager);
    
    vi.clearAllMocks();
    
    // Default mock for the token exchange
    mockFetch.mockImplementation(async (url) => {
      if (url === 'https://api.notion.com/v1/oauth/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'test-access-token',
            workspace_id: 'workspace-123',
            workspace_name: 'Test Workspace',
            workspace_icon: 'icon-url',
            bot_id: 'test-bot-id'
          })
        };
      }
      
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      };
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Workspace Registration', () => {
    it('should register a workspace and store the token', async () => {
      const code = 'test-auth-code';
      const userId = 'user-123';
      
      const result = await provider.registerWorkspace(code, userId);
      
      expect(result).toEqual({
        accessToken: 'test-access-token',
        workspaceId: 'workspace-123',
        workspaceName: 'Test Workspace',
        botId: 'test-bot-id'
      });
      
      // Verify token was stored
      const storedToken = await authManager.getUserToken(userId, 'workspace-123');
      expect(storedToken).toBe('test-access-token');
    });

    it('should handle token exchange failures', async () => {
      const code = 'invalid-code';
      const userId = 'user-123';
      
      // Mock token exchange failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid code'
      });
      
      await expect(provider.registerWorkspace(code, userId))
        .rejects.toThrow(ServiceError);
      
      // No token should be stored
      const storedToken = await authManager.getUserToken(userId, 'workspace-123');
      expect(storedToken).toBeNull();
    });
  });

  describe('Content Syncing', () => {
    it('should sync pages from a workspace', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      const mockPages = [
        {
          id: 'page-1',
          title: 'Test Page 1',
          last_edited_time: '2023-04-30T12:00:00Z',
          url: 'https://notion.so/page-1',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        },
        {
          id: 'page-2',
          title: 'Test Page 2',
          last_edited_time: '2023-04-29T12:00:00Z',
          url: 'https://notion.so/page-2',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        }
      ];
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue(mockPages);
      
      // Mock getPageContent
      vi.spyOn(client, 'getPageContent').mockImplementation(async (pageId) => {
        return `Content for ${pageId}`;
      });
      
      // Mock shouldIgnorePage
      vi.spyOn(notionUtils, 'shouldIgnorePage').mockReturnValue(false);
      
      const result = await provider.syncWorkspace(userId, workspaceId, null);
      
      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('page-1');
      expect(result.results[0].title).toBe('Test Page 1');
      expect(result.results[0].content).toBe('Content for page-1');
      expect(result.results[1].id).toBe('page-2');
      
      // New cursor should be the latest page timestamp
      expect(result.cursor).toBe('2023-04-30T12:00:00Z');
    });

    it('should skip pages that should be ignored', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      const mockPages = [
        {
          id: 'page-1',
          title: 'Should be ignored',
          last_edited_time: '2023-04-30T12:00:00Z',
          url: 'https://notion.so/page-1',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        },
        {
          id: 'page-2',
          title: 'Should be processed',
          last_edited_time: '2023-04-29T12:00:00Z',
          url: 'https://notion.so/page-2',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        }
      ];
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue(mockPages);
      
      // Mock getPageContent
      vi.spyOn(client, 'getPageContent').mockImplementation(async (pageId) => {
        return `Content for ${pageId}`;
      });
      
      // Mock shouldIgnorePage - only ignore page-1
      vi.spyOn(notionUtils, 'shouldIgnorePage').mockImplementation((page) => {
        return page.id === 'page-1';
      });
      
      const result = await provider.syncWorkspace(userId, workspaceId, null);
      
      // Only page-2 should be processed
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('page-2');
      
      // Cursor should still be the latest page timestamp
      expect(result.cursor).toBe('2023-04-30T12:00:00Z');
      
      // Verify getPageContent was only called for page-2
      expect(client.getPageContent).toHaveBeenCalledTimes(1);
      expect(client.getPageContent).toHaveBeenCalledWith('page-2');
    });

    it('should continue processing after an error with a specific page and track failed pages', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      const mockPages = [
        {
          id: 'page-1',
          title: 'Error Page',
          last_edited_time: '2023-04-30T12:00:00Z',
          url: 'https://notion.so/page-1',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        },
        {
          id: 'page-2',
          title: 'Good Page',
          last_edited_time: '2023-04-29T12:00:00Z',
          url: 'https://notion.so/page-2',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        }
      ];
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue(mockPages);
      
      // Mock getPageContent to fail for page-1
      vi.spyOn(client, 'getPageContent').mockImplementation(async (pageId) => {
        if (pageId === 'page-1') {
          throw new ServiceError('Failed to get content', {
            code: 'NOTION_CONTENT_ERROR',
            status: 500,
            context: { pageId }
          });
        }
        return `Content for ${pageId}`;
      });
      
      // Mock shouldIgnorePage
      vi.spyOn(notionUtils, 'shouldIgnorePage').mockReturnValue(false);
      
      // Mock console.error to avoid test output noise
      const originalConsoleError = console.error;
      console.error = vi.fn();
      
      const result = await provider.syncWorkspace(userId, workspaceId, null);
      
      // Restore console.error
      console.error = originalConsoleError;
      
      // Both pages should be in results, but one with error
      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('page-1');
      expect(result.results[0]).toHaveProperty('error');
      expect(result.results[1].id).toBe('page-2');
      expect(result.results[1]).not.toHaveProperty('error');
      
      // Error should have been logged
      expect(console.error).toHaveBeenCalled();
    });
    
    it('should handle nullish values in page properties gracefully', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      const mockPages = [
        {
          id: 'page-1',
          title: '', // Empty title (instead of null for type safety)
          last_edited_time: '2023-04-30T12:00:00Z',
          url: 'https://notion.so/page-1',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        }
      ];
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue(mockPages);
      
      // Mock getPageContent
      vi.spyOn(client, 'getPageContent').mockImplementation(async (pageId) => {
        return `Content for ${pageId}`;
      });
      
      // Mock shouldIgnorePage
      vi.spyOn(notionUtils, 'shouldIgnorePage').mockReturnValue(false);
      
      const result = await provider.syncWorkspace(userId, workspaceId, null);
      
      // Should process the page despite null title
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('page-1');
      expect(result.results[0].title).toBe(`Untitled (page-1)`);
    });

    it('should handle error when no user token is found', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      
      // Mock getUserToken to return null
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue(null);
      
      // We don't expect any further calls
      const getUpdatedPagesSpy = vi.spyOn(client, 'getUpdatedPages');
      const forUserSpy = vi.spyOn(client, 'forUser');
      
      // Should use the default client
      const result = await provider.syncWorkspace(userId, workspaceId, null);
      
      // Should still call getUpdatedPages with default client
      expect(getUpdatedPagesSpy).toHaveBeenCalled();
      expect(forUserSpy).toHaveBeenCalledWith(userId, workspaceId);
      
      // Verify we're using fallback client
      expect(forUserSpy.mock.results[0].value).resolves.toBe(client);
    });
    
    it('should log authentication errors and throw ServiceError', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      
      // Mock getUserToken to throw an error
      vi.spyOn(authManager, 'getUserToken').mockRejectedValue(
        new ServiceError('Authentication failed', { code: 'AUTH_ERROR', status: 401 })
      );
      
      // Mock console.error to avoid test noise
      const originalConsoleError = console.error;
      console.error = vi.fn();
      
      // Should throw ServiceError
      await expect(provider.syncWorkspace(userId, workspaceId, null))
        .rejects.toThrow(ServiceError);
      
      // Error should be logged
      expect(console.error).toHaveBeenCalled();
      
      // Restore console.error
      console.error = originalConsoleError;
    });

    it('should handle API error when fetching pages and propagate with context', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages to throw error
      const apiError = new ServiceError('API error', {
        code: 'NOTION_API_ERROR',
        status: 500,
        details: { workspaceId }
      });
      vi.spyOn(client, 'getUpdatedPages').mockRejectedValue(apiError);
      
      // Should propagate the error
      try {
        await provider.syncWorkspace(userId, workspaceId, null);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        const serviceError = error as ServiceError;
        expect(serviceError.code).toBeDefined();
        expect(serviceError).toHaveProperty('statusCode');
        expect(serviceError).toHaveProperty('details');
        // Error should include both original error info and new context
        expect(serviceError.message).toContain('API error');
      }
    });

    it('should return unchanged cursor when no pages are found', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      const initialCursor = '2023-04-28T12:00:00Z';
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages to return empty array
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue([]);
      
      const result = await provider.syncWorkspace(userId, workspaceId, initialCursor);
      
      expect(result.results).toHaveLength(0);
      expect(result.cursor).toBe(initialCursor);
    });
    
    it('should handle null cursor gracefully', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages to return empty array
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue([]);
      
      const result = await provider.syncWorkspace(userId, workspaceId, null);
      
      expect(result.results).toHaveLength(0);
      expect(result.cursor).toBeNull();
    });
    
    it('should handle cursor as empty string gracefully', async () => {
      const userId = 'user-123';
      const workspaceId = 'workspace-123';
      
      // Mock getUserToken
      vi.spyOn(authManager, 'getUserToken').mockResolvedValue('test-access-token');
      
      // Mock getUpdatedPages to return empty array
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue([]);
      
      // Use empty string instead of undefined
      const result = await provider.syncWorkspace(userId, workspaceId, '');
      
      expect(result.results).toHaveLength(0);
      // Should treat empty string similar to null
      expect(result.cursor).toBe('');
    });
  });

  describe('End-to-End Workflow', () => {
    it('should handle the complete workflow from registration to syncing', async () => {
      // Step 1: Register a workspace
      const code = 'test-auth-code';
      const userId = 'user-123';
      
      // Mock token exchange response
      mockFetch.mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'test-access-token',
          workspace_id: 'workspace-123',
          workspace_name: 'Test Workspace',
          workspace_icon: 'icon-url',
          bot_id: 'test-bot-id'
        })
      }));
      
      await provider.registerWorkspace(code, userId);
      
      // Step 2: Sync the workspace
      const mockPages = [
        {
          id: 'page-1',
          title: 'Test Page 1',
          last_edited_time: '2023-04-30T12:00:00Z',
          url: 'https://notion.so/page-1',
          parent: { type: 'workspace', workspace: true },
          properties: {}
        }
      ];
      
      // Mock API calls for syncing
      vi.spyOn(client, 'getUpdatedPages').mockResolvedValue(mockPages);
      vi.spyOn(client, 'getPageContent').mockResolvedValue('Test content');
      vi.spyOn(notionUtils, 'shouldIgnorePage').mockReturnValue(false);
      
      const syncResult = await provider.syncWorkspace(userId, 'workspace-123', null);
      
      expect(syncResult.results).toHaveLength(1);
      expect(syncResult.results[0].id).toBe('page-1');
      expect(syncResult.results[0].content).toBe('Test content');
      
      // Step 3: Verify metadata was created correctly
      expect(syncResult.results[0].metadata).toBeDefined();
      expect(syncResult.results[0].metadata.source.type).toBe('notion');
      expect(syncResult.results[0].metadata.source.repository).toBe('workspace-123');
      expect(syncResult.results[0].metadata.source.path).toBe('page-1');
    });
  });
});
