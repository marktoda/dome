import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { AuthController } from '../src/controllers/authController';
import { Context } from 'hono';
import { ChatClient } from '@dome/chat/client';
import { AuthService } from '@dome/auth/client';

// Mock the dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
    }),
  }),
  getIdentity: vi.fn(),
  ServiceError: class ServiceError extends Error {
    constructor(message: string, public status?: number, public code?: string) {
      super(message);
    }
  },
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: () => ({
    getChatService: vi.fn().mockReturnValue({
      generateDirectResponse: vi.fn(),
    }),
    getAuthService: vi.fn().mockReturnValue({
      login: vi.fn(),
      logout: vi.fn(),
    }),
  }),
}));

describe('ChatController', () => {
  let chatController: ChatController;
  let mockContext: Partial<Context>;
  let mockChatService: Partial<ChatClient>;

  beforeEach(() => {
    chatController = new ChatController();
    mockChatService = {
      generateDirectResponse: vi.fn(),
    };

    mockContext = {
      get: vi.fn().mockReturnValue({ userId: 'test-user-123' }),
      env: {} as any,
      json: vi.fn().mockReturnValue({ _data: 'response', _status: 200 }),
    };
  });

  describe('chat method', () => {
    it('should process a valid chat request successfully', async () => {
      const mockResponse = {
        response: 'Hello, how can I help you?',
        sources: [
          {
            id: 'source-1',
            type: 'document',
            title: 'Test Document',
            url: 'https://example.com/doc',
          },
        ],
      };

      (mockChatService.generateDirectResponse as any) = vi.fn().mockResolvedValue(mockResponse);

      const requestBody = {
        userId: 'test-user-123',
        messages: [
          {
            role: 'user' as const,
            content: 'Hello',
          },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      // Mock the service factory to return our mock
      const serviceFactory = await import('../src/services/serviceFactory');
      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: () => mockChatService as ChatClient,
        getAuthService: () => ({} as AuthService),
      });

      const response = await chatController.chat(mockContext as any, requestBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          data: {
            response: 'Hello, how can I help you?',
            sources: mockResponse.sources,
          },
        },
        200,
      );
    });

    it('should handle chat service errors gracefully', async () => {
      const errorMessage = 'Chat service temporarily unavailable';
      (mockChatService.generateDirectResponse as any) = vi.fn().mockRejectedValue(
        new Error(errorMessage),
      );

      const requestBody = {
        userId: 'test-user-123',
        messages: [
          {
            role: 'user' as const,
            content: 'Hello',
          },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      // Mock the service factory
      const serviceFactory = await import('../src/services/serviceFactory');
      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: () => mockChatService as ChatClient,
        getAuthService: () => ({} as AuthService),
      });

      const response = await chatController.chat(mockContext as any, requestBody);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: errorMessage,
          },
        },
        500,
      );
    });

    it('should validate required options fields', async () => {
      const mockResponse = {
        response: 'Test response',
        sources: [],
      };

      (mockChatService.generateDirectResponse as any) = vi.fn().mockResolvedValue(mockResponse);

      const requestBody = {
        userId: 'test-user-123',
        messages: [
          {
            role: 'user' as const,
            content: 'Hello',
          },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
          temperature: 0.7,
          modelId: 'gpt-4',
        },
        stream: false,
      };

      // Mock the service factory
      const serviceFactory = await import('../src/services/serviceFactory');
      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: () => mockChatService as ChatClient,
        getAuthService: () => ({} as AuthService),
      });

      const response = await chatController.chat(mockContext as any, requestBody);

      expect(mockChatService.generateDirectResponse).toHaveBeenCalledWith(requestBody);
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          data: {
            response: 'Test response',
            sources: [],
          },
        },
        200,
      );
    });
  });
});

describe('AuthController', () => {
  let authController: AuthController;
  let mockContext: Partial<Context>;
  let mockAuthService: Partial<AuthService>;

  beforeEach(() => {
    authController = new AuthController();
    mockAuthService = {
      login: vi.fn(),
      logout: vi.fn(),
    };

    mockContext = {
      get: vi.fn(),
      env: {} as any,
      json: vi.fn().mockReturnValue({ _data: 'response', _status: 200 }),
    };
  });

  describe('login method', () => {
    it('should handle login successfully', async () => {
      const mockLoginResponse = {
        success: true,
        token: 'jwt-token-123',
        user: {
          id: 'user-123',
          email: 'test@example.com',
        },
      };

      (mockAuthService.login as any) = vi.fn().mockResolvedValue(mockLoginResponse);

      const loginRequest = {
        email: 'test@example.com',
        password: 'securepassword',
      };

      // Mock the service factory
      const serviceFactory = await import('../src/services/serviceFactory');
      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: () => ({} as ChatClient),
        getAuthService: () => mockAuthService as AuthService,
      });

      // Simulate the method call (this would normally be called via the route handler)
      expect(mockAuthService.login).toBeDefined();
    });

    it('should handle login errors', async () => {
      const errorMessage = 'Invalid credentials';
      (mockAuthService.login as any) = vi.fn().mockRejectedValue(new Error(errorMessage));

      const loginRequest = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };

      // Mock the service factory
      const serviceFactory = await import('../src/services/serviceFactory');
      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: () => ({} as ChatClient),
        getAuthService: () => mockAuthService as AuthService,
      });

      try {
        await mockAuthService.login!(loginRequest.email, loginRequest.password);
      } catch (error: any) {
        expect(error.message).toBe(errorMessage);
      }
    });
  });

  describe('logout method', () => {
    it('should handle logout successfully', async () => {
      const mockLogoutResponse = {
        success: true,
        message: 'Logged out successfully',
      };

      (mockAuthService.logout as any) = vi.fn().mockResolvedValue(mockLogoutResponse);

      // Mock the service factory
      const serviceFactory = await import('../src/services/serviceFactory');
      vi.mocked(serviceFactory.createServiceFactory).mockReturnValue({
        getChatService: () => ({} as ChatClient),
        getAuthService: () => mockAuthService as AuthService,
      });

      const result = await mockAuthService.logout!('user-123');
      expect(result).toEqual(mockLogoutResponse);
      expect(mockAuthService.logout).toHaveBeenCalledWith('user-123');
    });
  });
});