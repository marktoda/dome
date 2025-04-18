import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { chatController } from '../../src/controllers/chatController';
import { chatService } from '../../src/services/chatService';

// Mock dependencies
vi.mock('../../src/services/chatService', () => ({
  chatService: {
    generateResponse: vi.fn(),
    streamResponse: vi.fn(),
  },
}));

describe('ChatController', () => {
  // Create a test app
  let app: Hono;

  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a new Hono app for each test
    app = new Hono();
    app.post('/chat', chatController.chat.bind(chatController));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /chat', () => {
    it('should return a successful response', async () => {
      // Mock chatService.generateResponse to return a test response
      vi.mocked(chatService.generateResponse).mockResolvedValue('This is a test response.');

      // Create a test request
      const req = new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user123',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Test message' }],
          stream: false,
          enhanceWithContext: true,
          maxContextItems: 5,
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Call the endpoint
      const res = await app.fetch(reqWithBindings);
      const data = await res.json();

      // Verify response
      expect(res.status).toBe(200);
      expect(data).toEqual({
        success: true,
        response: 'This is a test response.',
      });

      // Verify chatService was called with correct parameters
      expect(chatService.generateResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Test message' }],
          userId: 'user123',
          enhanceWithContext: true,
          maxContextItems: 5,
        }),
      );
    });

    it('should return a streaming response when stream is true', async () => {
      // Create a mock readable stream
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Chunk 1'));
          controller.enqueue(new TextEncoder().encode('Chunk 2'));
          controller.close();
        },
      });

      // Mock chatService.streamResponse to return the mock stream
      vi.mocked(chatService.streamResponse).mockResolvedValue(mockStream);

      // Create a test request
      const req = new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user123',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Test message' }],
          stream: true,
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Call the endpoint
      const res = await app.fetch(reqWithBindings);

      // Verify response
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Transfer-Encoding')).toBe('chunked');

      // Verify chatService was called with correct parameters
      expect(chatService.streamResponse).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Test message' }],
          userId: 'user123',
        }),
      );

      // Read the stream
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];

      let done = false;
      while (!done) {
        const { value, done: isDone } = await reader.read();
        if (isDone) {
          done = true;
        } else {
          chunks.push(value);
        }
      }

      // Combine chunks
      const allChunks = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, offset);
        offset += chunk.length;
      }

      // Verify stream content
      const content = new TextDecoder().decode(allChunks);
      expect(content).toBe('Chunk 1Chunk 2');
    });

    it('should return 401 when user ID is missing', async () => {
      // Create a test request without user ID
      const req = new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Test message' }],
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Call the endpoint
      const res = await app.fetch(reqWithBindings);
      const data = await res.json();

      // Verify response
      expect(res.status).toBe(401);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'User ID is required. Provide it via x-user-id header or userId query parameter',
        },
      });

      // Verify chatService was not called
      expect(chatService.generateResponse).not.toHaveBeenCalled();
      expect(chatService.streamResponse).not.toHaveBeenCalled();
    });

    it('should return 400 when request validation fails', async () => {
      // Create a test request with invalid data
      const req = new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user123',
        },
        body: JSON.stringify({
          messages: [], // Empty messages array (invalid)
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Call the endpoint
      const res = await app.fetch(reqWithBindings);
      const data = await res.json();

      // Verify response
      expect(res.status).toBe(400);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid chat request',
          details: expect.any(Array),
        },
      });

      // Verify chatService was not called
      expect(chatService.generateResponse).not.toHaveBeenCalled();
      expect(chatService.streamResponse).not.toHaveBeenCalled();
    });

    it('should return 500 when service error occurs', async () => {
      // Mock chatService.generateResponse to throw a ServiceError
      vi.mocked(chatService.generateResponse).mockRejectedValue(new Error('Test service error'));

      // Create a test request
      const req = new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user123',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Test message' }],
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Call the endpoint
      const res = await app.fetch(reqWithBindings);
      const data = await res.json();

      // Verify response
      expect(res.status).toBe(500);
      expect(data).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred during chat processing',
        },
      });

      // Verify chatService was called
      expect(chatService.generateResponse).toHaveBeenCalled();
    });
  });
});
