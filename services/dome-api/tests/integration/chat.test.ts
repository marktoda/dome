import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../../src/controllers/chatController';
import { ChatService } from '../../src/services/chatService';

// Mock dependencies
vi.mock('../../src/services/chatService', () => {
  return {
    ChatService: vi.fn().mockImplementation(() => {
      return {
        generateResponse: vi.fn(),
        streamResponse: vi.fn(),
      };
    }),
  };
});

// Mock logger
vi.mock('@dome/logging', () => {
  // Define the logger type to avoid TypeScript errors
  type MockLogger = {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
  };

  const mockLogger: MockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => mockLogger),
  };

  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    metrics: {
      increment: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({
        stop: vi.fn(),
      })),
    },
  };
});

describe('Chat API Integration Tests', () => {
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

  // Create mock instances
  let mockChatService: ChatService;
  let controller: ChatController;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock instances
    mockChatService = new ChatService(null as any);
    controller = new ChatController(mockChatService);

    // Mock chatService.generateResponse
    vi.mocked(mockChatService.generateResponse).mockResolvedValue('This is a test response');

    // Mock chatService.streamResponse
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue('This is a test stream response');
        controller.close();
      },
    });
    vi.mocked(mockChatService.streamResponse).mockResolvedValue(mockStream);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Chat Controller', () => {
    it('should generate a chat response', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            messages: [{ role: 'user', content: 'Hello, how are you?' }],
            stream: false,
            enhanceWithContext: true,
          }),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        set: vi.fn(),
        json: vi.fn(),
      };

      // Call the chat controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockChatService.generateResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
          enhanceWithContext: true,
        }),
      );
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        response: 'This is a test response',
      });
    });

    it('should stream a chat response', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            messages: [{ role: 'user', content: 'Stream a response to me.' }],
            stream: true,
            enhanceWithContext: true,
          }),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        set: vi.fn(),
        body: vi.fn(),
      };

      // Call the chat controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockChatService.streamResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          messages: [{ role: 'user', content: 'Stream a response to me.' }],
          enhanceWithContext: true,
        }),
      );
      expect(mockContext.set).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
      expect(mockContext.body).toHaveBeenCalled();
    });

    it('should return 401 when user ID is missing', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            messages: [{ role: 'user', content: 'Hello, how are you?' }],
            stream: false,
          }),
          header: vi.fn(() => null), // No user ID
        },
        env: mockEnv,
        set: vi.fn(),
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Call the chat controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(401);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
        }),
      });
    });

    it('should return 400 when messages are missing', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            // Missing required messages field
            stream: false,
          }),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        set: vi.fn(),
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Call the chat controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(400);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('should return 400 when no user message is provided', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            messages: [
              { role: 'system', content: 'System message' },
              // No user message
            ],
            stream: false,
          }),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        set: vi.fn(),
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Call the chat controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(400);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('should handle service errors', async () => {
      // Create a mock context
      const mockContext = {
        req: {
          json: vi.fn().mockResolvedValue({
            messages: [{ role: 'user', content: 'Hello, how are you?' }],
            stream: false,
          }),
          header: vi.fn(name => (name === 'x-user-id' ? mockUserId : null)),
        },
        env: mockEnv,
        set: vi.fn(),
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      // Mock service error
      vi.mocked(mockChatService.generateResponse).mockRejectedValue(
        new Error('Chat service error'),
      );

      // Call the chat controller
      await controller.chat(mockContext as any);

      // Verify the response
      expect(mockContext.status).toHaveBeenCalledWith(500);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'SERVICE_ERROR',
        }),
      });
    });
  });
});
