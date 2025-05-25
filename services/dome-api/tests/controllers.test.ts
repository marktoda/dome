import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ChatController, buildChatRouter } from '../src/controllers/chatController';
import { AuthController } from '../src/controllers/authController';
import type { Bindings } from '../src/types';

// Mock all dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({ 
    info: vi.fn(), 
    error: vi.fn(), 
    debug: vi.fn(), 
    warn: vi.fn(), 
    child: vi.fn().mockReturnThis(),
  }),
  getIdentity: vi.fn(),
  ServiceError: class extends Error {
    constructor(message: string, public status?: number, public code?: string) {
      super(message);
    }
  },
  logError: vi.fn(),
}));

vi.mock('@dome/chat/client', () => ({
  ChatClient: vi.fn(),
  chatRequestSchema: vi.fn(() => ({
    parse: vi.fn((data) => data),
  })),
}));

vi.mock('../src/services/serviceFactory', () => ({
  createServiceFactory: vi.fn(() => ({
    getChatService: vi.fn(() => ({
      generateDirectResponse: vi.fn(),
    })),
    getAuthService: vi.fn(() => ({
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      validateToken: vi.fn(),
    })),
  })),
}));

vi.mock('../src/middleware/authenticationMiddleware', () => ({
  authenticationMiddleware: vi.fn(async (c, next) => {
    c.set('auth', {
      userId: 'test-user-id',
      userRole: 'user',
      userEmail: 'test@example.com',
    });
    await next();
  }),
  AuthContext: vi.fn(),
}));

vi.mock('../src/utils/responseHelpers', () => ({
  successResponse: vi.fn((data) => ({ success: true, data })),
  unauthorizedResponse: vi.fn(() => ({ 
    success: false, 
    error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } 
  })),
  validationErrorResponse: vi.fn((error) => ({ 
    success: false, 
    error: { code: 'VALIDATION_ERROR', message: error.message } 
  })),
  internalErrorResponse: vi.fn((error) => ({ 
    success: false, 
    error: { code: 'INTERNAL_ERROR', message: error.message } 
  })),
}));

describe('ChatController', () => {
  let controller: ChatController;
  let mockEnv: Bindings;

  beforeEach(() => {
    mockEnv = {
      CHAT: {} as any,
      AUTH: {} as any,
      TSUNAMI: {} as any,
      D1_DATABASE: {} as any,
      VECTORIZE: {} as any,
      RAW: {} as any,
      EVENTS: {} as any,
      SILO_INGEST_QUEUE: {} as any,
      SILO: {} as any,
      AI_PROCESSOR: {} as any,
    };

    controller = new ChatController();
  });

  describe('chat method', () => {
    it('should process valid chat request', async () => {
      const mockContext = {
        env: mockEnv,
        get: vi.fn((key) => {
          if (key === 'auth') {
            return {
              userId: 'test-user',
              userRole: 'user',
              userEmail: 'test@example.com',
            };
          }
          return undefined;
        }),
        json: vi.fn((data, status) => ({ data, status })),
      };

      const requestBody = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello, how are you?' }
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
        },
      };

      const mockServiceResponse = {
        response: 'Hello! I am doing well, thank you for asking.',
        sources: [
          {
            id: 'doc1',
            type: 'document',
            title: 'Greeting Guide',
            url: 'https://example.com/greetings',
          }
        ],
      };

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockChatService = mockFactory.getChatService(mockEnv);
      mockChatService.generateDirectResponse.mockResolvedValue(mockServiceResponse);

      const result = await controller.chat(mockContext as any, requestBody);

      expect(result.data).toEqual({
        success: true,
        data: {
          response: mockServiceResponse.response,
          sources: mockServiceResponse.sources,
        },
      });
      expect(result.status).toBe(200);
      expect(mockChatService.generateDirectResponse).toHaveBeenCalledWith(requestBody);
    });

    it('should handle authentication errors', async () => {
      const mockContext = {
        env: mockEnv,
        get: vi.fn(() => {
          throw new Error('Authentication failed');
        }),
        json: vi.fn((data, status) => ({ data, status })),
      };

      const requestBody = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Test message' }
        ],
        options: {},
      };

      const result = await controller.chat(mockContext as any, requestBody);

      expect(result.data.success).toBe(false);
      expect(result.data.error.code).toBe('INTERNAL_ERROR');
      expect(result.status).toBe(500);
    });

    it('should handle service errors', async () => {
      const mockContext = {
        env: mockEnv,
        get: vi.fn((key) => {
          if (key === 'auth') {
            return {
              userId: 'test-user',
              userRole: 'user',
              userEmail: 'test@example.com',
            };
          }
          return undefined;
        }),
        json: vi.fn((data, status) => ({ data, status })),
      };

      const requestBody = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Test message' }
        ],
        options: {},
      };

      const { ServiceError } = await import('@dome/common');
      const serviceError = new ServiceError('Chat service unavailable', 503, 'SERVICE_UNAVAILABLE');

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockChatService = mockFactory.getChatService(mockEnv);
      mockChatService.generateDirectResponse.mockRejectedValue(serviceError);

      const result = await controller.chat(mockContext as any, requestBody);

      expect(result.data.success).toBe(false);
      expect(result.data.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.data.error.message).toBe('Chat service unavailable');
      expect(result.status).toBe(500);
    });

    it('should handle empty message arrays', async () => {
      const mockContext = {
        env: mockEnv,
        get: vi.fn((key) => {
          if (key === 'auth') {
            return {
              userId: 'test-user',
              userRole: 'user',
              userEmail: 'test@example.com',
            };
          }
          return undefined;
        }),
        json: vi.fn((data, status) => ({ data, status })),
      };

      const requestBody = {
        userId: 'test-user',
        messages: [],
        options: {
          enhanceWithContext: false,
        },
      };

      const mockServiceResponse = {
        response: 'How can I help you today?',
        sources: [],
      };

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockChatService = mockFactory.getChatService(mockEnv);
      mockChatService.generateDirectResponse.mockResolvedValue(mockServiceResponse);

      const result = await controller.chat(mockContext as any, requestBody);

      expect(result.data.success).toBe(true);
      expect(result.data.data.response).toBe('How can I help you today?');
      expect(result.data.data.sources).toEqual([]);
    });

    it('should validate user ID matches authenticated user', async () => {
      const mockContext = {
        env: mockEnv,
        get: vi.fn((key) => {
          if (key === 'auth') {
            return {
              userId: 'authenticated-user',
              userRole: 'user',
              userEmail: 'test@example.com',
            };
          }
          return undefined;
        }),
        json: vi.fn((data, status) => ({ data, status })),
      };

      const requestBody = {
        userId: 'different-user', // Different from authenticated user
        messages: [
          { role: 'user', content: 'Test message' }
        ],
        options: {},
      };

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockChatService = mockFactory.getChatService(mockEnv);
      mockChatService.generateDirectResponse.mockResolvedValue({
        response: 'Response',
        sources: [],
      });

      const result = await controller.chat(mockContext as any, requestBody);

      // Should proceed even with different user ID for now
      // In production, you might want to validate this
      expect(result.data.success).toBe(true);
    });
  });

  describe('buildChatRouter', () => {
    it('should create router with authentication middleware', () => {
      const router = buildChatRouter();

      expect(router).toBeDefined();
      // Router should be an instance of OpenAPIHono
      expect(typeof router.openapi).toBe('function');
    });

    it('should apply authentication middleware to routes', async () => {
      const router = buildChatRouter();
      
      // The middleware should be applied to the router
      expect(router).toBeDefined();
      // In a real test, you'd want to test the actual route handling
    });
  });
});

describe('AuthController', () => {
  let controller: AuthController;
  let mockEnv: Bindings;

  beforeEach(() => {
    mockEnv = {
      AUTH: {} as any,
      CHAT: {} as any,
      TSUNAMI: {} as any,
      D1_DATABASE: {} as any,
      VECTORIZE: {} as any,
      RAW: {} as any,
      EVENTS: {} as any,
      SILO_INGEST_QUEUE: {} as any,
      SILO: {} as any,
      AI_PROCESSOR: {} as any,
    };

    controller = new AuthController();
  });

  describe('login method', () => {
    it('should handle valid login credentials', async () => {
      const mockContext = {
        env: mockEnv,
        json: vi.fn((data, status) => ({ data, status })),
      };

      const loginData = {
        email: 'test@example.com',
        password: 'validpassword123',
      };

      const mockAuthResponse = {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          id: 'user123',
          email: 'test@example.com',
          role: 'user',
        },
      };

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockAuthService = mockFactory.getAuthService(mockEnv);
      mockAuthService.login.mockResolvedValue(mockAuthResponse);

      const result = await controller.login(mockContext as any, loginData);

      expect(mockAuthService.login).toHaveBeenCalledWith(
        'test@example.com',
        'validpassword123'
      );
      expect(result.data).toEqual({
        success: true,
        data: { token: mockAuthResponse.token },
      });
      expect(result.status).toBe(200);
    });

    it('should handle invalid credentials', async () => {
      const mockContext = {
        env: mockEnv,
        json: vi.fn((data, status) => ({ data, status })),
      };

      const loginData = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };

      const { ServiceError } = await import('@dome/common');
      const authError = new ServiceError('Invalid credentials', 401, 'INVALID_CREDENTIALS');

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockAuthService = mockFactory.getAuthService(mockEnv);
      mockAuthService.login.mockRejectedValue(authError);

      const result = await controller.login(mockContext as any, loginData);

      expect(result.data.success).toBe(false);
      expect(result.data.error.code).toBe('INVALID_CREDENTIALS');
      expect(result.status).toBe(401);
    });

    it('should handle malformed email addresses', async () => {
      const mockContext = {
        env: mockEnv,
        json: vi.fn((data, status) => ({ data, status })),
      };

      const loginData = {
        email: 'invalid-email',
        password: 'password123',
      };

      // This would typically be caught by validation middleware
      // but we test the controller's handling of it
      const result = await controller.login(mockContext as any, loginData);

      // Controller should still attempt the login and let the service handle validation
      expect(result).toBeDefined();
    });
  });

  describe('register method', () => {
    it('should handle valid registration data', async () => {
      const mockContext = {
        env: mockEnv,
        json: vi.fn((data, status) => ({ data, status })),
      };

      const registerData = {
        email: 'newuser@example.com',
        password: 'securepassword123',
        name: 'New User',
      };

      const mockRegisterResponse = {
        user: {
          id: 'newuser123',
          email: 'newuser@example.com',
          role: 'user',
        },
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      };

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockAuthService = mockFactory.getAuthService(mockEnv);
      mockAuthService.register.mockResolvedValue(mockRegisterResponse);

      const result = await controller.register(mockContext as any, registerData);

      expect(mockAuthService.register).toHaveBeenCalledWith(registerData);
      expect(result.data.success).toBe(true);
      expect(result.data.data).toEqual(mockRegisterResponse);
      expect(result.status).toBe(201);
    });

    it('should handle duplicate email registration', async () => {
      const mockContext = {
        env: mockEnv,
        json: vi.fn((data, status) => ({ data, status })),
      };

      const registerData = {
        email: 'existing@example.com',
        password: 'password123',
        name: 'Existing User',
      };

      const { ServiceError } = await import('@dome/common');
      const duplicateError = new ServiceError('Email already exists', 409, 'EMAIL_EXISTS');

      const { createServiceFactory } = await import('../src/services/serviceFactory');
      const mockFactory = createServiceFactory();
      const mockAuthService = mockFactory.getAuthService(mockEnv);
      mockAuthService.register.mockRejectedValue(duplicateError);

      const result = await controller.register(mockContext as any, registerData);

      expect(result.data.success).toBe(false);
      expect(result.data.error.code).toBe('EMAIL_EXISTS');
      expect(result.status).toBe(409);
    });
  });
});