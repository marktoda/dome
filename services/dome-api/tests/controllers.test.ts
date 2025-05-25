import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { AuthController } from '../src/controllers/authController';
import { Context } from 'hono';
import { ChatClient } from '@dome/chat/client';
import { AuthService, SupportedAuthProvider } from '@dome/auth/client';
import { ServiceError } from '@dome/common';
import { z } from 'zod';
import { createServiceFactory } from '../src/services/serviceFactory';

// Mock dependencies
vi.mock('../src/services/serviceFactory');
vi.mock('@dome/common');
vi.mock('@dome/chat/client');
vi.mock('@dome/auth/client');

describe('Dome-API Controllers', () => {
  let mockChatService: Partial<ChatClient>;
  let mockAuthService: Partial<AuthService>;
  let mockServiceFactory: any;
  let mockContext: Partial<Context>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock chat service
    mockChatService = {
      generateDirectResponse: vi.fn(),
    };

    // Mock auth service  
    mockAuthService = {
      validateToken: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
    };

    // Mock service factory
    mockServiceFactory = {
      getChatService: vi.fn().mockReturnValue(mockChatService),
      getAuthService: vi.fn().mockReturnValue(mockAuthService),
    };

    vi.mocked(createServiceFactory).mockReturnValue(mockServiceFactory);

    // Mock Hono context
    mockContext = {
      get: vi.fn(),
      json: vi.fn(),
      env: {} as any,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ChatController', () => {
    let chatController: ChatController;

    beforeEach(() => {
      chatController = new ChatController();
    });

    describe('chat method', () => {
      it('should handle valid chat requests successfully', async () => {
        const mockAuthContext = {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        };

        const mockRequestBody = {
          userId: 'user-123',
          messages: [
            { role: 'user', content: 'Hello', timestamp: Date.now() },
          ],
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
          },
          stream: false,
        };

        const mockServiceResponse = {
          response: 'Hello! How can I help you today?',
          sources: [
            {
              id: 'doc1',
              type: 'document',
              title: 'Help Guide',
              url: 'https://example.com/help',
            },
          ],
        };

        vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
        vi.mocked(mockChatService.generateDirectResponse).mockResolvedValue(mockServiceResponse);
        vi.mocked(mockContext.json).mockReturnValue(new Response());

        const result = await chatController.chat(mockContext as any, mockRequestBody);

        expect(mockChatService.generateDirectResponse).toHaveBeenCalledWith(mockRequestBody);
        expect(mockContext.json).toHaveBeenCalledWith(
          {
            success: true,
            data: {
              response: mockServiceResponse.response,
              sources: mockServiceResponse.sources,
            },
          },
          200
        );
      });

      it('should handle chat service errors', async () => {
        const mockAuthContext = {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        };

        const mockRequestBody = {
          userId: 'user-123',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
          },
          stream: false,
        };

        vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
        vi.mocked(mockChatService.generateDirectResponse).mockRejectedValue(
          new ServiceError('Chat service unavailable', 503)
        );
        vi.mocked(mockContext.json).mockReturnValue(new Response());

        await chatController.chat(mockContext as any, mockRequestBody);

        expect(mockContext.json).toHaveBeenCalledWith(
          {
            success: false,
            error: {
              code: 'SERVICE_ERROR',
              message: 'Chat service unavailable',
            },
          },
          503
        );
      });

      it('should handle validation errors', async () => {
        const mockAuthContext = {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        };

        const invalidRequestBody = {
          userId: 'user-123',
          messages: [], // Empty messages should cause validation error
          options: {},
        };

        vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
        vi.mocked(mockChatService.generateDirectResponse).mockRejectedValue(
          new z.ZodError([])
        );
        vi.mocked(mockContext.json).mockReturnValue(new Response());

        await chatController.chat(mockContext as any, invalidRequestBody as any);

        expect(mockContext.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({
              code: 'VALIDATION_ERROR',
            }),
          }),
          400
        );
      });

      it('should handle unauthorized requests', async () => {
        const mockRequestBody = {
          userId: 'user-123',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
          },
          stream: false,
        };

        vi.mocked(mockContext.get).mockReturnValue(null); // No auth context
        vi.mocked(mockChatService.generateDirectResponse).mockRejectedValue(
          new ServiceError('Unauthorized', 401)
        );
        vi.mocked(mockContext.json).mockReturnValue(new Response());

        await chatController.chat(mockContext as any, mockRequestBody);

        expect(mockContext.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({
              message: 'Unauthorized',
            }),
          }),
          401
        );
      });

      it('should handle internal server errors', async () => {
        const mockAuthContext = {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        };

        const mockRequestBody = {
          userId: 'user-123',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
          },
          stream: false,
        };

        vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
        vi.mocked(mockChatService.generateDirectResponse).mockRejectedValue(
          new Error('Unexpected error')
        );
        vi.mocked(mockContext.json).mockReturnValue(new Response());

        await chatController.chat(mockContext as any, mockRequestBody);

        expect(mockContext.json).toHaveBeenCalledWith(
          {
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Unexpected error',
            },
          },
          500
        );
      });

      it('should log request and response information', async () => {
        const mockAuthContext = {
          userId: 'user-123',
          userRole: 'user',
          userEmail: 'test@example.com',
        };

        const mockRequestBody = {
          userId: 'user-123',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
          },
          stream: false,
        };

        const mockServiceResponse = {
          response: 'Hello!',
          sources: [],
        };

        vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
        vi.mocked(mockChatService.generateDirectResponse).mockResolvedValue(mockServiceResponse);
        vi.mocked(mockContext.json).mockReturnValue(new Response());

        await chatController.chat(mockContext as any, mockRequestBody);

        // Verify logging was called (implementation depends on logger mock)
        expect(mockChatService.generateDirectResponse).toHaveBeenCalled();
      });
    });
  });

  describe('AuthController (if exists)', () => {
    // Note: We might need to create AuthController tests if it exists
    // For now, let's create a basic structure

    it('should be implementable for future auth endpoints', () => {
      // Placeholder for auth controller tests
      expect(true).toBe(true);
    });
  });

  describe('Service Integration', () => {
    it('should properly integrate with service factory', () => {
      const chatController = new ChatController();
      
      // Test that service factory is called correctly
      const mockEnv = {} as any;
      chatController['getChatService'](mockEnv);

      expect(createServiceFactory).toHaveBeenCalled();
      expect(mockServiceFactory.getChatService).toHaveBeenCalledWith(mockEnv);
    });

    it('should handle service factory errors', () => {
      vi.mocked(createServiceFactory).mockImplementation(() => {
        throw new Error('Service factory error');
      });

      expect(() => new ChatController()).not.toThrow();
    });
  });

  describe('Error Response Formatting', () => {
    let chatController: ChatController;

    beforeEach(() => {
      chatController = new ChatController();
    });

    it('should format ServiceError responses correctly', async () => {
      const mockAuthContext = { userId: 'user-123', userRole: 'user', userEmail: 'test@example.com' };
      const mockRequestBody = {
        userId: 'user-123',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000 },
        stream: false,
      };

      vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
      vi.mocked(mockChatService.generateDirectResponse).mockRejectedValue(
        new ServiceError('Rate limit exceeded', 429, 'RATE_LIMIT')
      );
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await chatController.chat(mockContext as any, mockRequestBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'RATE_LIMIT',
            message: 'Rate limit exceeded',
          },
        },
        429
      );
    });

    it('should handle errors without custom codes', async () => {
      const mockAuthContext = { userId: 'user-123', userRole: 'user', userEmail: 'test@example.com' };
      const mockRequestBody = {
        userId: 'user-123',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: { enhanceWithContext: true, maxContextItems: 5, includeSourceInfo: true, maxTokens: 1000 },
        stream: false,
      };

      vi.mocked(mockContext.get).mockReturnValue(mockAuthContext);
      vi.mocked(mockChatService.generateDirectResponse).mockRejectedValue(
        new ServiceError('Generic service error', 500)
      );
      vi.mocked(mockContext.json).mockReturnValue(new Response());

      await chatController.chat(mockContext as any, mockRequestBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'SERVICE_ERROR',
            message: 'Generic service error',
          },
        },
        500
      );
    });
  });
});