import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { chatController } from '../../src/controllers/chatController';
import { chatService } from '../../src/services/chatService';
import { userIdMiddleware } from '../../src/middleware/userIdMiddleware';

// Mock dependencies
vi.mock('../../src/services/chatService', () => ({
  chatService: {
    generateResponse: vi.fn(),
    streamResponse: vi.fn(),
  },
}));

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    })),
  })),
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(),
    })),
  },
}));

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

  // Create Hono app for testing
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();

    // Instead of using Hono for testing, we'll directly mock the responses
    // This approach avoids issues with URL parsing in Hono during tests
    
    // Mock the chatService.generateResponse
    vi.mocked(chatService.generateResponse).mockResolvedValue('This is a test response');
    
    // Mock the chatService.streamResponse
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue('This is a test stream response');
        controller.close();
      },
    });
    vi.mocked(chatService.streamResponse).mockResolvedValue(mockStream);

    // Mock chatService.generateResponse
    vi.mocked(chatService.generateResponse).mockResolvedValue('This is a test response');

    // Mock chatService.streamResponse
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue('This is a test stream response');
        controller.close();
      },
    });
    vi.mocked(chatService.streamResponse).mockResolvedValue(mockStream);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /api/chat', () => {
    it('should return chat response successfully', async () => {
      // Arrange
      const requestBody = {
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
        stream: false,
        enhanceWithContext: true,
      };

      const req = new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: JSON.stringify(requestBody),
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(200);
      expect(data).toEqual({
        success: true,
        response: 'This is a test response',
      });
      expect(chatService.generateResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          messages: requestBody.messages,
          enhanceWithContext: true,
        }),
      );
    });

    it('should return streaming response when stream is true', async () => {
      // Arrange
      const requestBody = {
        messages: [{ role: 'user', content: 'Stream a response to me.' }],
        stream: true,
        enhanceWithContext: true,
      };

      const req = new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: JSON.stringify(requestBody),
      });

      // Act
      const res = await app.fetch(req, mockEnv);

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Transfer-Encoding')).toBe('chunked');
      expect(chatService.streamResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          messages: requestBody.messages,
          enhanceWithContext: true,
        }),
      );
    });

    it('should return 401 when user ID is missing', async () => {
      // Arrange
      const requestBody = {
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
        stream: false,
      };

      const req = new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(401);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: expect.stringContaining('User ID is required'),
        },
      });
    });

    it('should return 400 when messages are missing', async () => {
      // Arrange
      const requestBody = {
        // Missing required messages field
        stream: false,
      };

      const req = new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: JSON.stringify(requestBody),
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(400);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid chat parameters',
          details: expect.any(Array),
        },
      });
    });

    it('should return 400 when no user message is provided', async () => {
      // Arrange
      const requestBody = {
        messages: [
          { role: 'system', content: 'System message' },
          // No user message
        ],
        stream: false,
      };

      const req = new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: JSON.stringify(requestBody),
      });

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(400);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('user message is required'),
        },
      });
    });

    it('should handle service errors', async () => {
      // Arrange
      const requestBody = {
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
        stream: false,
      };

      const req = new Request('http://localhost:8787/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': mockUserId,
        },
        body: JSON.stringify(requestBody),
      });

      // Mock service error
      vi.mocked(chatService.generateResponse).mockRejectedValue(new Error('Chat service error'));

      // Act
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      // Assert
      expect(res.status).toBe(500);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'SERVICE_ERROR',
          message: expect.stringContaining('error'),
        },
      });
    });
  });
});
