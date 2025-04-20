import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatController } from '../../src/controllers/chatController';
import { chatService } from '../../src/services/chatService';
import { ServiceError, UnauthorizedError, ValidationError } from '@dome/common';
import { z } from 'zod';

// Mock dependencies
vi.mock('../../src/services/chatService', () => ({
  chatService: {
    generateResponse: vi.fn(),
    streamResponse: vi.fn(),
  },
}));

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('ChatController', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    AI: {
      run: vi.fn(),
    },
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Create mock context
  const createMockContext = (
    options: {
      userId?: string;
      body?: any;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {},
  ) => {
    const mockJson = vi.fn();
    const mockReq = {
      json: vi.fn().mockResolvedValue(options.body || {}),
      header: vi.fn(name => {
        if (name === 'x-user-id') return options.headers?.['x-user-id'] || null;
        return null;
      }),
      query: vi.fn(name => {
        if (name === 'userId') return options.query?.['userId'] || null;
        return options.query?.[name] || null;
      }),
      path: '/api/chat',
      method: 'POST',
    };

    return {
      env: mockEnv,
      req: mockReq,
      json: mockJson,
      get: vi.fn().mockImplementation(key => {
        if (key === 'userId') return options.userId || mockUserId;
        return null;
      }),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('chat', () => {
    it('should return chat response successfully', async () => {
      // Arrange
      const mockMessages = [{ role: 'user', content: 'Hello, how are you?' }];

      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          messages: mockMessages,
          stream: false,
          enhanceWithContext: true,
        },
        headers: { 'x-user-id': mockUserId },
      });

      const mockResponse = 'I am doing well, thank you for asking!';
      vi.mocked(chatService.generateResponse).mockResolvedValue(mockResponse);

      // Act
      const response = await chatController.chat(mockContext as any);

      // Assert
      expect(chatService.generateResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          messages: mockMessages,
          enhanceWithContext: true,
        }),
      );

      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        response: mockResponse,
      });
    });

    it('should handle streaming response', async () => {
      // Arrange
      const mockMessages = [{ role: 'user', content: 'Stream a response to me.' }];

      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          messages: mockMessages,
          stream: true,
          enhanceWithContext: true,
        },
        headers: { 'x-user-id': mockUserId },
      });

      const mockStream = new ReadableStream();
      vi.mocked(chatService.streamResponse).mockResolvedValue(mockStream);

      // Act
      const response = await chatController.chat(mockContext as any);

      // Assert
      expect(chatService.streamResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          messages: mockMessages,
          enhanceWithContext: true,
        }),
      );

      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('Transfer-Encoding')).toBe('chunked');
    });

    it('should throw error when user ID is missing', async () => {
      // Arrange
      const mockMessages = [{ role: 'user', content: 'Hello, how are you?' }];

      const mockContext = createMockContext({
        userId: undefined,
        body: {
          messages: mockMessages,
          stream: false,
        },
        headers: {}, // No user ID header
        query: {}, // No user ID query param
      });

      // Act & Assert
      await expect(chatController.chat(mockContext as any)).rejects.toThrow(UnauthorizedError);
    });

    it('should handle validation errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          // Missing required messages field
          stream: false,
        },
        headers: { 'x-user-id': mockUserId },
      });

      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'array',
          received: 'undefined',
          path: ['messages'],
          message: 'Required',
        },
      ]);

      // Mock the parse method to throw a ZodError
      vi.spyOn(z.ZodObject.prototype, 'parse').mockImplementation(() => {
        throw zodError;
      });

      // Act
      try {
        await chatController.chat(mockContext as any);
        // If we get here, the test should fail
        expect(true).toBe(false);
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(z.ZodError);
      }
    });

    it('should handle service errors', async () => {
      // Arrange
      const mockMessages = [{ role: 'user', content: 'Hello, how are you?' }];

      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          messages: mockMessages,
          stream: false,
        },
        headers: { 'x-user-id': mockUserId },
      });

      const serviceError = new ServiceError('Chat service error', {
        code: 'CHAT_ERROR',
        status: 503,
      });
      vi.mocked(chatService.generateResponse).mockRejectedValue(serviceError);

      // Act
      try {
        await chatController.chat(mockContext as any);
        // If we get here, the test should fail
        expect(true).toBe(false);
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).message).toBe('Chat service error');
      }
    });

    it('should handle missing user message', async () => {
      // Arrange
      const mockMessages = [
        { role: 'system', content: 'System message' },
        // No user message
      ];

      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          messages: mockMessages,
          stream: false,
        },
        headers: { 'x-user-id': mockUserId },
      });

      // Act
      try {
        await chatController.chat(mockContext as any);
        // If we get here, the test should fail
        expect(true).toBe(false);
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toBe('At least one user message is required');
      }
    });
  });
});
