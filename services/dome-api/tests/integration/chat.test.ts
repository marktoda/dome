import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../../src/controllers/chatController';
import { ChatService } from '../../src/services/chatService';
import { mockChatService, mockEnv } from '../mocks/serviceMocks';
import { Context } from 'hono';

// Mock dependencies
vi.mock('../../src/services/chatService');

// Create a mock logger that can be accessed globally
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
};

// Mock logger
vi.mock('@dome/logging', () => {
  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    logError: vi.fn(),
  };
});

describe('Chat API Integration Tests', () => {
  // Mock user ID
  const mockUserId = 'user-123';

  // Create mock instances
  let controller: ChatController;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create controller instance
    controller = new ChatController(mockChatService as unknown as ChatService);

    // Mock chatService.generateResponse
    mockChatService.generateResponse.mockResolvedValue('This is a test response');

    // Mock chatService.streamResponse
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue('This is a test stream response');
        controller.close();
      },
    });
    
    const mockResponse = new Response(mockStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
    
    mockChatService.streamResponse.mockResolvedValue(mockResponse);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // Helper function to create a mock Hono context
  const createMockContext = (options: {
    body?: any;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    stream?: boolean;
  }) => {
    const mockJson = vi.fn();
    const mockHeaders = new Headers();
    
    if (options.headers) {
      Object.entries(options.headers).forEach(([key, value]) => {
        mockHeaders.set(key, value);
      });
    }
    
    // Store the body for json() method
    const bodyContent = options.body;
    
    const mockRequest = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: mockHeaders,
      body: bodyContent ? JSON.stringify(bodyContent) : undefined,
    });
    
    // Add header and query methods to the request object
    (mockRequest as any).header = (name: string) => mockHeaders.get(name);
    (mockRequest as any).query = (name: string) => options.query?.[name] || null;
    (mockRequest as any).path = '/api/chat';
    (mockRequest as any).method = 'POST';
    (mockRequest as any).json = vi.fn().mockResolvedValue(bodyContent || {});
    
    return {
      req: mockRequest,
      env: mockEnv,
      json: mockJson,
    };
  };

  describe('Chat Controller', () => {
    it('should generate a chat response', async () => {
      // Create a mock context
      const mockContext = createMockContext({
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: {
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
        },
      });

      // Call the controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        response: 'This is a test response',
      });
      expect(mockChatService.generateResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
          userId: mockUserId,
        }),
      );
    });

    it('should stream a chat response', async () => {
      // Create a mock context
      const mockContext = createMockContext({
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: {
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
          stream: true,
        },
      });

      // Call the controller
      const response = await controller.chat(mockContext as any);

      // Verify the response
      expect(response).toBeInstanceOf(Response);
      expect(mockChatService.streamResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
          userId: mockUserId,
          stream: true,
        }),
      );
    });

    it('should return 401 when user ID is missing', async () => {
      // Create a mock context without user ID
      const mockContext = createMockContext({
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
        },
      });

      // Call the controller and expect it to throw
      await expect(controller.chat(mockContext as any)).rejects.toThrow();
    });

    it('should return 400 when messages are missing', async () => {
      // Create a mock context without messages
      const mockContext = createMockContext({
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: {},
      });

      // Call the controller and expect it to throw
      await expect(controller.chat(mockContext as any)).rejects.toThrow();
    });

    it('should return 400 when no user message is provided', async () => {
      // Create a mock context with only assistant messages
      const mockContext = createMockContext({
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: {
          messages: [{ role: 'assistant', content: 'Hello, how can I help you?' }],
        },
      });

      // Call the controller and expect it to throw
      await expect(controller.chat(mockContext as any)).rejects.toThrow();
    });

    it('should handle service errors', async () => {
      // Create a mock context
      const mockContext = createMockContext({
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: {
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
        },
      });

      // Mock the service to throw an error
      mockChatService.generateResponse.mockRejectedValue(new Error('Service error'));

      // Call the controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'CHAT_ERROR',
          }),
        }),
        200,
      );
    });
  });
});


