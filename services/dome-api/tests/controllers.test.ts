import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServiceFactory, ServiceFactory } from '../src/services/serviceFactory';
import { ChatClient } from '@dome/chat/client';
import { AuthService } from '@dome/auth/client';
import { SupportedAuthProvider } from '@dome/auth/types';
import { ChatController } from '../src/controllers/chatController';
import { AuthController } from '../src/controllers/authController';
import { Bindings } from '../src/types';

// Mock the service factory
vi.mock('../src/services/serviceFactory');

describe('ChatController', () => {
  let mockChatService: ChatClient;
  let chatController: ChatController;
  let mockEnv: Bindings;

  beforeEach(() => {
    // Create mock chat service
    mockChatService = {
      generateDirectResponse: vi.fn(),
    } as any;

    // Mock the service factory to return our mock chat service
    const mockServiceFactory = {
      getChatService: vi.fn().mockReturnValue(mockChatService),
    };

    vi.mocked(createServiceFactory).mockReturnValue(mockServiceFactory as any);

    mockEnv = {} as Bindings;
    chatController = new ChatController();
  });

  describe('chat', () => {
    it('should handle non-streaming chat requests successfully', async () => {
      const mockResponse = {
        response: 'Test response',
        sources: [{ id: '1', type: 'test', title: 'Test Source' }],
      };

      (mockChatService.generateDirectResponse as any).mockResolvedValue(mockResponse);

      // Mock Hono context
      const mockContext = {
        env: mockEnv,
        get: vi.fn().mockReturnValue({ userId: 'test-user' }),
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const requestBody = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      const result = await chatController.chat(mockContext, requestBody);

      expect(mockChatService.generateDirectResponse).toHaveBeenCalledWith(requestBody);
      expect(result._data).toEqual({
        success: true,
        data: mockResponse,
      });
      expect(result._status).toBe(200);
    });

    it('should handle errors gracefully', async () => {
      const error = new Error('Chat service error');
      (mockChatService.generateDirectResponse as any).mockRejectedValue(error);

      const mockContext = {
        env: mockEnv,
        get: vi.fn().mockReturnValue({ userId: 'test-user' }),
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const requestBody = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      const result = await chatController.chat(mockContext, requestBody);

      expect(result._data.success).toBe(false);
      expect(result._data.error.code).toBe('INTERNAL_ERROR');
      expect(result._status).toBe(500);
    });

    it('should pass through all request parameters correctly', async () => {
      const mockResponse = { response: 'Test response' };
      (mockChatService.generateDirectResponse as any).mockResolvedValue(mockResponse);

      const mockContext = {
        env: mockEnv,
        get: vi.fn().mockReturnValue({ userId: 'test-user-123' }),
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const requestBody = {
        userId: 'test-user-123',
        messages: [
          { role: 'user', content: 'Question 1' },
          { role: 'assistant', content: 'Answer 1' },
          { role: 'user', content: 'Question 2' },
        ],
        options: {
          enhanceWithContext: false,
          maxContextItems: 10,
          includeSourceInfo: false,
          maxTokens: 2000,
          temperature: 0.7,
          modelId: 'gpt-4',
        },
        stream: false,
        runId: 'test-run-123',
      };

      await chatController.chat(mockContext, requestBody);

      expect(mockChatService.generateDirectResponse).toHaveBeenCalledWith(requestBody);
    });
  });
});

describe('AuthController', () => {
  let mockAuthService: AuthService;
  let authController: AuthController;
  let mockEnv: Bindings;

  beforeEach(() => {
    mockAuthService = {
      validateToken: vi.fn(),
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    } as any;

    // Mock the service factory to return our mock auth service
    const mockServiceFactory = {
      getAuthService: vi.fn().mockReturnValue(mockAuthService),
    };

    vi.mocked(createServiceFactory).mockReturnValue(mockServiceFactory as any);

    mockEnv = {} as Bindings;
    authController = new AuthController();
  });

  describe('validateToken', () => {
    it('should validate a token successfully', async () => {
      const mockValidationResponse = {
        success: true,
        userId: 'test-user',
        provider: SupportedAuthProvider.LOCAL,
        user: { 
          id: 'test-user', 
          email: 'test@example.com',
          name: 'Test User',
          role: 'user',
          emailVerified: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLoginAt: new Date(),
          authProvider: SupportedAuthProvider.LOCAL,
          providerAccountId: 'test@example.com'
        },
      };

      (mockAuthService.validateToken as any).mockResolvedValue(mockValidationResponse);

      const mockContext = {
        env: mockEnv,
        req: {
          header: vi.fn().mockReturnValue('Bearer valid-token'),
        },
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const result = await authController.validateToken(mockContext);

      expect(mockAuthService.validateToken).toHaveBeenCalledWith('valid-token', SupportedAuthProvider.LOCAL);
      expect(result._data.success).toBe(true);
      expect(result._data.user.id).toBe('test-user');
      expect(result._status).toBe(200);
    });

    it('should handle missing authorization header', async () => {
      const mockContext = {
        env: mockEnv,
        req: {
          header: vi.fn().mockReturnValue(undefined),
        },
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const result = await authController.validateToken(mockContext);

      expect(result._data.success).toBe(false);
      expect(result._data.error.code).toBe('UNAUTHORIZED');
      expect(result._status).toBe(401);
    });
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      const mockRegisterResponse = {
        success: true,
        user: { id: 'new-user', email: 'new@example.com' },
        token: 'new-token',
        tokenType: 'bearer',
        provider: 'local',
      };

      (mockAuthService.register as any).mockResolvedValue(mockRegisterResponse);

      const mockContext = {
        env: mockEnv,
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const registrationData = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      const result = await authController.register(mockContext, registrationData);

      expect(mockAuthService.register).toHaveBeenCalledWith(SupportedAuthProvider.LOCAL, registrationData);
      expect(result._data.token).toBe('new-token');
      expect(result._status).toBe(201);
    });

    it('should handle registration errors', async () => {
      const error = new Error('Registration failed');
      (mockAuthService.register as any).mockRejectedValue(error);

      const mockContext = {
        env: mockEnv,
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const registrationData = {
        email: 'existing@example.com',
        password: 'password123',
        name: 'Existing User',
      };

      const result = await authController.register(mockContext, registrationData);

      expect(result._data.success).toBe(false);
      expect(result._status).toBe(400);
    });
  });

  describe('login', () => {
    it('should login a user successfully', async () => {
      const mockLoginResponse = {
        success: true,
        user: { id: 'test-user', email: 'test@example.com' },
        token: 'auth-token',
        tokenType: 'bearer',
        provider: 'local',
      };

      (mockAuthService.login as any).mockResolvedValue(mockLoginResponse);

      const mockContext = {
        env: mockEnv,
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const loginData = {
        email: 'test@example.com',
        password: 'password123',
      };

      const result = await authController.login(mockContext, loginData);

      expect(mockAuthService.login).toHaveBeenCalledWith(SupportedAuthProvider.LOCAL, loginData);
      expect(result._data.token).toBe('auth-token');
      expect(result._status).toBe(200);
    });

    it('should handle login failures', async () => {
      const mockLoginResponse = {
        success: false,
        user: null,
        token: '',
        tokenType: '',
        provider: 'local',
      };

      (mockAuthService.login as any).mockResolvedValue(mockLoginResponse);

      const mockContext = {
        env: mockEnv,
        json: vi.fn().mockImplementation((data, status) => ({ _data: data, _status: status })),
      } as any;

      const loginData = {
        email: 'wrong@example.com',
        password: 'wrongpassword',
      };

      const result = await authController.login(mockContext, loginData);

      expect(result._data.success).toBe(false);
      expect(result._status).toBe(401);
    });
  });
});