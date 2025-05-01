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
    const mockStatus = vi.fn().mockReturnThis();

    return {
      env: mockEnv,
      get: vi.fn().mockReturnValue(mockUserId),
      req: {
        param: mockParam,
        query: mockQuery,
        json: () => jsonPromise,
        path: '/content/notion',
        method: 'POST',
      },
      json: mockJson,
      status: mockStatus,
      set: vi.fn().mockReturnThis(),
      // Add these properties to ensure proper error handling
      error: vi.fn(),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn()
      }
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

    it('should handle service errors with proper error details', async () => {
      // Arrange
      const requestBody = {
        workspaceId: 'workspace-123',
        userId: 'user-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      const serviceError = new ServiceError('Failed to register workspace', {
        code: 'REGISTRATION_ERROR',
        status: 503,
        details: {
          workspaceId: 'workspace-123',
          reason: 'Tsunami service unavailable'
        }
      });
      
      vi.mocked(mockTsunamiClient.registerNotionWorkspace).mockRejectedValue(serviceError);

      // Act & Assert
      await expect(controller.registerNotionWorkspace(mockContext as any)).rejects.toThrow(serviceError);
      
      // Verify the error is logged with details
      expect(mockContext.logger?.error).toHaveBeenCalled();
    });
    
    it('should handle unexpected errors gracefully', async () => {
      // Arrange
      const requestBody = {
        workspaceId: 'workspace-123',
        userId: 'user-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      // Non-ServiceError
      const unexpectedError = new Error('Unexpected failure');
      
      vi.mocked(mockTsunamiClient.registerNotionWorkspace).mockRejectedValue(unexpectedError);

      // Act & Assert
      await expect(controller.registerNotionWorkspace(mockContext as any)).rejects.toThrow();
    });

    it('should handle validation errors with detailed error message', async () => {
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
      
      // Verify error logging
      expect(mockContext.logger?.error).toHaveBeenCalled();
    });
    
    it('should handle empty or null values in input gracefully', async () => {
      // Arrange - provide empty strings which should be validated
      const requestBody = {
        workspaceId: '',
        userId: '',
        cadence: '',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      // Act & Assert
      await expect(controller.registerNotionWorkspace(mockContext as any)).rejects.toThrow();
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

    it('should use default limit when not provided and handle all parameter types', async () => {
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
      
      // Test with non-numeric limit
      const invalidLimitContext = createMockContext(params, { limit: 'abc' });
      await controller.getNotionWorkspaceHistory(invalidLimitContext as any);
      
      // Should still use default limit for non-numeric input
      expect(mockTsunamiClient.getNotionWorkspaceHistory).toHaveBeenCalledWith(
        'workspace-123',
        10 // Default limit
      );
      
      // Test with zero limit
      const zeroLimitContext = createMockContext(params, { limit: '0' });
      await controller.getNotionWorkspaceHistory(zeroLimitContext as any);
      
      // Should use minimum limit for zero input
      expect(mockTsunamiClient.getNotionWorkspaceHistory).toHaveBeenCalledWith(
        'workspace-123',
        1 // Minimum sensible limit
      );
    });

    it('should handle service errors with proper logging', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      const mockContext = createMockContext(params);
      
      const serviceError = new ServiceError('Failed to get workspace history', {
        code: 'HISTORY_ERROR',
        status: 503,
        details: {
          workspaceId: 'workspace-123',
          requestId: 'test-request-id'
        }
      });
      
      vi.mocked(mockTsunamiClient.getNotionWorkspaceHistory).mockRejectedValue(serviceError);

      // Act & Assert
      await expect(controller.getNotionWorkspaceHistory(mockContext as any)).rejects.toThrow(serviceError);
      
      // Verify error logging with context
      expect(mockContext.logger?.error).toHaveBeenCalled();
    });
    
    it('should handle missing workspaceId parameter', async () => {
      // Arrange - missing required parameter
      const params = {};
      
      const mockContext = createMockContext(params);
      
      // Act & Assert
      await expect(controller.getNotionWorkspaceHistory(mockContext as any))
        .rejects.toThrow(); // Should throw validation error
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

    it('should handle errors during response creation', async () => {
      // Arrange
      const params = {
        workspaceId: 'workspace-123',
      };
      
      const mockContext = createMockContext(params);
      
      // Mock an implementation that throws an error during JSON response
      mockContext.json = vi.fn().mockImplementation(() => {
        throw new Error('Failed to trigger sync');
      });

      // Act & Assert
      await expect(controller.triggerNotionWorkspaceSync(mockContext as any))
        .rejects.toThrow('Failed to trigger sync');
        
      // Check that error is logged
      expect(mockContext.logger?.error).toHaveBeenCalled();
    });
    
    it('should validate workspaceId is not empty', async () => {
      // Arrange - empty workspaceId
      const params = {
        workspaceId: '',
      };
      
      const mockContext = createMockContext(params);

      // Act & Assert
      await expect(controller.triggerNotionWorkspaceSync(mockContext as any))
        .rejects.toThrow(); // Should throw validation error
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

    it('should handle validation errors and log them properly', async () => {
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
      
      // Verify error is logged
      expect(mockContext.logger?.error).toHaveBeenCalled();
    });
    
    it('should validate all required OAuth parameters', async () => {
      // Arrange - missing userId
      const requestBodyMissingUserId = {
        code: 'oauth-code-123',
        redirectUri: 'https://example.com/callback',
        // Missing userId
      };
      
      const mockContext = createMockContext({}, {}, requestBodyMissingUserId);
      
      // Act & Assert
      await expect(controller.configureNotionOAuth(mockContext as any))
        .rejects.toThrow(); // Should throw validation error for missing userId
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

    it('should handle validation errors in OAuth URL request', async () => {
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
      
      // Verify error logging
      expect(mockContext.logger?.error).toHaveBeenCalled();
    });
    
    it('should validate redirectUri format', async () => {
      // Arrange - invalid URL format
      const requestBody = {
        redirectUri: 'not-a-valid-url',
        state: 'random-state-123',
      };
      
      const mockContext = createMockContext({}, {}, requestBody);
      
      // Act & Assert
      await expect(controller.getNotionOAuthUrl(mockContext as any))
        .rejects.toThrow(); // Should throw validation error for invalid URL
    });
  });
});