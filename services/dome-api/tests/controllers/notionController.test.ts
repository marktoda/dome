import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotionController } from '../../src/controllers/notionController';
import { TsunamiClient } from '@dome/tsunami/client';
import { ServiceError } from '@dome/common';
import { z } from 'zod';

// Mock dependencies
vi.mock('@dome/tsunami/client', () => {
  return {
    TsunamiClient: vi.fn().mockImplementation(() => {
      return {
        registerNotionWorkspace: vi.fn(),
        getNotionWorkspaceHistory: vi.fn(),
      };
    }),
  };
});

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  }),
}));

describe('NotionController', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    TSUNAMI: {} as any,
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Create mock context
  const createMockContext = (params: Record<string, string> = {}, query: Record<string, string> = {}, body = {}) => {
    const mockJson = vi.fn();
    const mockParam = vi.fn((key: string) => params[key] || undefined);
    const mockQuery = vi.fn((key: string) => query[key] || undefined);
    const jsonPromise = Promise.resolve(body);

    return {
      env: mockEnv,
      get: vi.fn().mockReturnValue(mockUserId),
      req: {
        param: mockParam,
        query: mockQuery,
        json: () => jsonPromise,
      },
      json: mockJson,
    };
  };

  // Create mock instances
  let mockTsunamiClient: TsunamiClient;
  let controller: NotionController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTsunamiClient = new TsunamiClient({} as any);
    controller = new NotionController(mockTsunamiClient);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('registerNotionWorkspace', () => {
    it('should register a Notion workspace successfully', async () => {
      // Arrange
      const requestBody = {
        workspaceId: 'workspace-123',
        userId: 'user-123',
        cadence: 'PT2H',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      const mockResult = {
        id: 'sync-123',
        resourceId: 'workspace-123',
        wasInitialised: true,
      };
      
      vi.mocked(mockTsunamiClient.registerNotionWorkspace).mockResolvedValue(mockResult);

      // Act
      const response = await controller.registerNotionWorkspace(mockContext as any);

      // Assert
      expect(mockTsunamiClient.registerNotionWorkspace).toHaveBeenCalledWith(
        'workspace-123',
        'user-123',
        7200 // 2 hours in seconds
      );
      
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        ...mockResult
      });
    });

    it('should handle default cadence value', async () => {
      // Arrange
      const requestBody = {
        workspaceId: 'workspace-123',
        userId: 'user-123',
        // No cadence provided
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      const mockResult = {
        id: 'sync-123',
        resourceId: 'workspace-123',
        wasInitialised: true,
      };
      
      vi.mocked(mockTsunamiClient.registerNotionWorkspace).mockResolvedValue(mockResult);

      // Act
      const response = await controller.registerNotionWorkspace(mockContext as any);

      // Assert
      expect(mockTsunamiClient.registerNotionWorkspace).toHaveBeenCalledWith(
        'workspace-123',
        'user-123',
        3600 // Default 1 hour in seconds
      );
      
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        ...mockResult
      });
    });

    it('should handle service errors', async () => {
      // Arrange
      const requestBody = {
        workspaceId: 'workspace-123',
        userId: 'user-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      const serviceError = new ServiceError('Failed to register workspace', {
        code: 'REGISTRATION_ERROR',
        status: 503,
      });
      
      vi.mocked(mockTsunamiClient.registerNotionWorkspace).mockRejectedValue(serviceError);

      // Act & Assert
      await expect(controller.registerNotionWorkspace(mockContext as any)).rejects.toThrow(serviceError);
    });

    it('should handle validation errors', async () => {
      // Arrange
      const requestBody = {
        // Missing required workspaceId
        userId: 'user-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['workspaceId'],
          message: 'Required',
        },
      ]);

      // Mock req.json to throw a ZodError
      mockContext.req.json = () => Promise.reject(zodError);

      // Act & Assert
      await expect(controller.registerNotionWorkspace(mockContext as any)).rejects.toThrow(zodError);
    });
  });

  describe('getNotionWorkspaceHistory', () => {
    it('should get workspace history successfully', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      const query = {
        limit: '5',
      };
      
      const mockContext = createMockContext(params, query);
      
      const historyResult = {
        workspaceId: 'workspace-123',
        resourceId: 'workspace-123',
        history: [
          { id: 'history-1', timestamp: 1617235678000 },
          { id: 'history-2', timestamp: 1617235679000 },
        ],
      };
      
      vi.mocked(mockTsunamiClient.getNotionWorkspaceHistory).mockResolvedValue(historyResult);

      // Act
      const response = await controller.getNotionWorkspaceHistory(mockContext as any);

      // Assert
      expect(mockTsunamiClient.getNotionWorkspaceHistory).toHaveBeenCalledWith(
        'workspace-123',
        5
      );
      
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        ...historyResult
      });
    });

    it('should use default limit when not provided', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      // No limit provided in query
      const mockContext = createMockContext(params);
      
      const historyResult = {
        workspaceId: 'workspace-123',
        resourceId: 'workspace-123',
        history: [
          { id: 'history-1', timestamp: 1617235678000 },
        ],
      };
      
      vi.mocked(mockTsunamiClient.getNotionWorkspaceHistory).mockResolvedValue(historyResult);

      // Act
      const response = await controller.getNotionWorkspaceHistory(mockContext as any);

      // Assert
      expect(mockTsunamiClient.getNotionWorkspaceHistory).toHaveBeenCalledWith(
        'workspace-123',
        10 // Default limit
      );
      
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        ...historyResult
      });
    });

    it('should handle service errors', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      const mockContext = createMockContext(params);
      
      const serviceError = new ServiceError('Failed to get workspace history', {
        code: 'HISTORY_ERROR',
        status: 503,
      });
      
      vi.mocked(mockTsunamiClient.getNotionWorkspaceHistory).mockRejectedValue(serviceError);

      // Act & Assert
      await expect(controller.getNotionWorkspaceHistory(mockContext as any)).rejects.toThrow(serviceError);
    });
  });

  describe('triggerNotionWorkspaceSync', () => {
    it('should trigger workspace sync successfully', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      const mockContext = createMockContext(params);

      // Act
      const response = await controller.triggerNotionWorkspaceSync(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        message: 'Notion workspace sync has been triggered',
        workspaceId: 'workspace-123'
      });
    });

    it('should handle errors', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      const mockContext = createMockContext(params);
      
      // Mock an implementation that throws an error
      mockContext.json = vi.fn().mockImplementation(() => {
        throw new Error('Failed to trigger sync');
      });

      // Act & Assert
      await expect(controller.triggerNotionWorkspaceSync(mockContext as any)).rejects.toThrow('Failed to trigger sync');
    });
  });

  describe('configureNotionOAuth', () => {
    it('should configure OAuth successfully', async () => {
      // Arrange
      const requestBody = {
        code: 'oauth-code-123',
        redirectUri: 'https://example.com/callback',
        userId: 'user-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);

      // Act
      const response = await controller.configureNotionOAuth(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        message: 'Notion OAuth configured successfully',
        userId: 'user-123'
      });
    });

    it('should handle validation errors', async () => {
      // Arrange
      const requestBody = {
        // Missing required code
        redirectUri: 'https://example.com/callback',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['code'],
          message: 'Required',
        },
      ]);

      // Mock req.json to throw a ZodError
      mockContext.req.json = () => Promise.reject(zodError);

      // Act & Assert
      await expect(controller.configureNotionOAuth(mockContext as any)).rejects.toThrow(zodError);
    });
  });

  describe('getNotionOAuthUrl', () => {
    it('should get OAuth URL successfully', async () => {
      // Arrange
      const requestBody = {
        redirectUri: 'https://example.com/callback',
        state: 'random-state-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);

      // Act
      const response = await controller.getNotionOAuthUrl(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        url: expect.stringContaining('https://api.notion.com/v1/oauth/authorize')
      });
      
      // Verify URL contains correct parameters
      const responseUrl = mockContext.json.mock.calls[0][0].url;
      expect(responseUrl).toContain(`redirect_uri=${encodeURIComponent('https://example.com/callback')}`);
      expect(responseUrl).toContain(`state=random-state-123`);
    });

    it('should handle URL without state', async () => {
      // Arrange
      const requestBody = {
        redirectUri: 'https://example.com/callback',
        // No state provided
      };
      
      const mockContext = createMockContext({}, {}, requestBody);

      // Act
      const response = await controller.getNotionOAuthUrl(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        url: expect.stringContaining('https://api.notion.com/v1/oauth/authorize')
      });
      
      // Verify URL does not contain state parameter
      const responseUrl = mockContext.json.mock.calls[0][0].url;
      expect(responseUrl).not.toContain(`state=`);
    });

    it('should handle validation errors', async () => {
      // Arrange
      const requestBody = {
        // Missing required redirectUri
        state: 'random-state-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['redirectUri'],
          message: 'Required',
        },
      ]);

      // Mock req.json to throw a ZodError
      mockContext.req.json = () => Promise.reject(zodError);

      // Act & Assert
      await expect(controller.getNotionOAuthUrl(mockContext as any)).rejects.toThrow(zodError);
    });
  });
});