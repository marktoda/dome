import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { chatController } from '../../src/controllers/chatController';
import { chatService } from '../../src/services/chatService';

// Mock dependencies
vi.mock('../../src/services/chatService', () => ({
  chatService: {
    generateResponse: vi.fn(),
    streamResponse: vi.fn()
  }
}));

describe('Chat Streaming Integration', () => {
  // Create a test app
  let app: Hono;
  
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn()
    },
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>
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

  it('should stream chat response chunks', async () => {
    // Create a mock readable stream
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('This '));
        controller.enqueue(new TextEncoder().encode('is '));
        controller.enqueue(new TextEncoder().encode('a '));
        controller.enqueue(new TextEncoder().encode('streaming '));
        controller.enqueue(new TextEncoder().encode('response.'));
        controller.close();
      }
    });

    // Mock chatService.streamResponse to return the mock stream
    vi.mocked(chatService.streamResponse).mockResolvedValue(mockStream);

    // Create a test request
    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user'
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Test streaming message' }
        ],
        stream: true
      })
    });

    // Add bindings to the request
    const reqWithBindings = Object.assign(req, {
      env: mockEnv
    });

    // Call the endpoint
    const res = await app.fetch(reqWithBindings);

    // Verify response headers
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('Transfer-Encoding')).toBe('chunked');

    // Read the stream
    const reader = res.body!.getReader();
    let result = '';
    
    let done = false;
    while (!done) {
      const { value, done: isDone } = await reader.read();
      if (isDone) {
        done = true;
      } else {
        result += new TextDecoder().decode(value);
      }
    }
    
    // Verify the complete streamed response
    expect(result).toBe('This is a streaming response.');

    // Verify chatService was called with correct parameters
    expect(chatService.streamResponse).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Test streaming message' }],
        userId: 'test-user',
        stream: true
      })
    );
  });

  it('should return a regular JSON response when stream is false', async () => {
    // Mock chatService.generateResponse to return a test response
    vi.mocked(chatService.generateResponse).mockResolvedValue('This is a non-streaming response.');

    // Create a test request
    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user'
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Test non-streaming message' }
        ],
        stream: false
      })
    });

    // Add bindings to the request
    const reqWithBindings = Object.assign(req, {
      env: mockEnv
    });

    // Call the endpoint
    const res = await app.fetch(reqWithBindings);
    
    // Verify response
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data).toEqual({
      success: true,
      response: 'This is a non-streaming response.'
    });

    // Verify chatService was called with correct parameters
    expect(chatService.generateResponse).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Test non-streaming message' }],
        userId: 'test-user',
        stream: false
      })
    );
  });

  it('should handle errors during streaming', async () => {
    // Mock chatService.streamResponse to throw an error
    vi.mocked(chatService.streamResponse).mockRejectedValue(
      new Error('AI service error')
    );

    // Create a test request
    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user'
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Test error handling' }
        ],
        stream: true
      })
    });

    // Add bindings to the request
    const reqWithBindings = Object.assign(req, {
      env: mockEnv
    });

    // Call the endpoint
    const res = await app.fetch(reqWithBindings);

    // Verify response status
    expect(res.status).toBe(500);
    
    // Verify error response
    const data = await res.json();
    expect(data).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred during chat processing'
      }
    });

    // Verify chatService was called
    expect(chatService.streamResponse).toHaveBeenCalled();
  });
});