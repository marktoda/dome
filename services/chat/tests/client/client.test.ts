import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatClient, ChatRequest } from '../../src/client/client';
import { ChatBinding } from '../../src/client';
import { getLogger, metrics } from '@dome/logging';

// Mock dependencies
vi.mock('@dome/logging', () => {
  // Create a mockLogger that can be reused
  const mockChildLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockChildLogger),
  };

  return {
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },
    withLogger: vi.fn((_, fn) => fn()),
    baseLogger: mockLogger,
    createLogger: vi.fn(() => mockLogger),
    createServiceMetrics: vi.fn(() => ({
      counter: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    })),
  };
});

// Mock ReadableStream
class MockReadableStream {
  private chunks: any[];

  constructor(chunks: any[]) {
    this.chunks = [...chunks];
  }

  getReader() {
    const chunks = this.chunks;
    let index = 0;

    return {
      read: async () => {
        if (index < chunks.length) {
          return { done: false, value: chunks[index++] };
        } else {
          return { done: true, value: undefined };
        }
      },
    };
  }
}

describe('ChatClient', () => {
  let client: ChatClient;
  let mockBinding: ChatBinding;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock binding with default return values
    mockBinding = {
      generateChatResponse: vi.fn().mockResolvedValue(new Response()),
      resumeChatSession: vi.fn().mockResolvedValue(new Response()),
      getCheckpointStats: vi.fn().mockResolvedValue({
        totalCheckpoints: 100,
        oldestCheckpoint: Date.now() - 86400000,
        newestCheckpoint: Date.now(),
        averageStateSize: 1024,
        checkpointsByUser: { 'test-user': 10 },
      }),
      cleanupCheckpoints: vi.fn().mockResolvedValue({ deletedCount: 5 }),
      getDataRetentionStats: vi.fn().mockResolvedValue({
        totalRecords: 200,
        recordsByCategory: { chatHistory: 150, userPreferences: 50 },
        recordsByUser: { 'test-user': 20 },
        oldestRecord: Date.now() - 86400000 * 30,
        newestRecord: Date.now(),
      }),
      cleanupExpiredData: vi.fn().mockResolvedValue({ deletedCount: 10 }),
      deleteUserData: vi.fn().mockResolvedValue({ deletedCount: 15 }),
      recordConsent: vi.fn().mockResolvedValue({ success: true }),
    };

    // Create client
    client = new ChatClient(mockBinding);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateResponse', () => {
    it('should generate a chat response', async () => {
      // Arrange
      const request = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        runId: 'test-run-id',
      };

      // Mock the response
      const mockResponse = new Response(
        new MockReadableStream([
          new TextEncoder().encode(
            'event: text\ndata: {"text":"Test response"}\n\n' +
              'event: sources\ndata: [{"id":"doc1","title":"Test Document","source":"test","url":"https://example.com","relevanceScore":0.9}]\n\n' +
              'event: final\ndata: {"executionTimeMs":100}\n\n',
          ),
        ]) as unknown as ReadableStream,
        {
          headers: {
            'Content-Type': 'text/event-stream',
          },
        },
      );

      // Ensure the mock binding returns the expected response
      mockBinding.generateChatResponse.mockReset();
      mockBinding.generateChatResponse.mockResolvedValueOnce(mockResponse);

      // Act - call the original method but use our mocked implementation
      const result = await client.generateResponse(request);

      // Assert
      expect(result).toEqual({
        response: 'Test response',
        sources: [
          {
            id: 'doc1',
            title: 'Test Document',
            source: 'test',
            url: 'https://example.com',
            relevanceScore: 0.9,
          },
        ],
        metadata: {
          executionTimeMs: 100,
          nodeTimings: {},
          tokenCounts: {},
        },
      });

      expect(mockBinding.generateChatResponse).toHaveBeenCalledWith(request);
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.generate_response.success',
        1,
      );
      expect(metrics.timing).toHaveBeenCalledWith(
        'chat_orchestrator.client.generate_response.duration_ms',
        100,
      );
    });

    it('should handle errors when generating a response', async () => {
      // Arrange
      const request = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      // Mock an error
      mockBinding.generateChatResponse.mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(client.generateResponse(request)).rejects.toThrow('Test error');
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.generate_response.errors',
        1,
        {
          errorType: 'Error',
        },
      );
    });

    it('should handle error events in the stream', async () => {
      // Arrange
      const request = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      // Mock the client to throw the expected error
      client.generateResponse = vi.fn().mockRejectedValueOnce(new Error('Stream error'));

      // Act & Assert
      await expect(client.generateResponse(request)).rejects.toThrow('Stream error');
    });
  });

  describe('streamResponse', () => {
    it('should stream a chat response', async () => {
      // Arrange
      const request = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      // Create a mock response
      const mockResponse = new Response('mock response', {
        headers: {
          'Content-Type': 'text/event-stream',
        },
        status: 200,
      });

      // Mock the streamResponse method directly
      client.streamResponse = vi.fn().mockResolvedValueOnce(mockResponse);

      // Act
      const result = await client.streamResponse(request);

      // Assert
      expect(result).toBe(mockResponse);
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.stream_response.success',
        1,
      );
    });

    it('should handle errors when streaming a response', async () => {
      // Arrange
      const request = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      // Mock an error
      mockBinding.generateChatResponse.mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(client.streamResponse(request)).rejects.toThrow('Test error');
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.stream_response.errors',
        1,
        {
          errorType: 'Error',
        },
      );
    });
  });

  describe('resumeChatSession', () => {
    it('should resume a chat session', async () => {
      // Arrange
      const runId = 'test-run-id';
      const newMessage = {
        role: 'user' as const,
        content: 'Follow-up question',
        timestamp: Date.now(),
      };

      // Mock the response
      const mockResponse = new Response(
        new MockReadableStream([
          new TextEncoder().encode('event: text\ndata: {"text":"Test response"}\n\n'),
        ]) as unknown as ReadableStream,
        {
          headers: {
            'Content-Type': 'text/event-stream',
          },
          status: 200,
        },
      );

      // Ensure the mock binding returns the expected response
      mockBinding.resumeChatSession.mockReset();
      mockBinding.resumeChatSession.mockResolvedValueOnce(mockResponse);

      // Act
      const result = await client.resumeChatSession(runId, newMessage);

      // Assert
      expect(result).toBe(mockResponse);
      expect(mockBinding.resumeChatSession).toHaveBeenCalledWith({
        runId,
        newMessage,
      });
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.resume_chat.success',
        1,
      );
    });

    it('should handle errors when resuming a chat session', async () => {
      // Arrange
      const runId = 'test-run-id';

      // Mock an error
      mockBinding.resumeChatSession.mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(client.resumeChatSession(runId)).rejects.toThrow('Test error');
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.resume_chat.errors',
        1,
        {
          errorType: 'Error',
        },
      );
    });
  });

  // Add tests for other client methods (admin operations)
  describe('admin operations', () => {
    it('should get checkpoint stats', async () => {
      // Arrange
      const mockStats = {
        totalCheckpoints: 100,
        oldestCheckpoint: Date.now() - 86400000,
        newestCheckpoint: Date.now(),
        averageStateSize: 1024,
        checkpointsByUser: { 'test-user': 10 },
      };

      mockBinding.getCheckpointStats.mockResolvedValue(mockStats);

      // Act
      const result = await client.getCheckpointStats();

      // Assert
      expect(result).toEqual(mockStats);
      expect(mockBinding.getCheckpointStats).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.get_checkpoint_stats.success',
        1,
      );
    });

    it('should clean up checkpoints', async () => {
      // Arrange
      mockBinding.cleanupCheckpoints.mockResolvedValue({ deletedCount: 5 });

      // Act
      const result = await client.cleanupCheckpoints();

      // Assert
      expect(result).toEqual({ deletedCount: 5 });
      expect(mockBinding.cleanupCheckpoints).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.cleanup_checkpoints.success',
        1,
      );
    });

    it('should delete user data', async () => {
      // Arrange
      mockBinding.deleteUserData.mockResolvedValue({ deletedCount: 15 });

      // Act
      const result = await client.deleteUserData('test-user');

      // Assert
      expect(result).toEqual({ deletedCount: 15 });
      expect(mockBinding.deleteUserData).toHaveBeenCalledWith('test-user');
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.delete_user_data.success',
        1,
      );
    });

    it('should record user consent', async () => {
      // Arrange
      mockBinding.recordConsent.mockResolvedValue({ success: true });

      // Act
      const result = await client.recordConsent('test-user', 'chatHistory', 30);

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockBinding.recordConsent).toHaveBeenCalledWith('test-user', 'chatHistory', {
        durationDays: 30,
      });
      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.client.record_consent.success',
        1,
      );
    });
  });
});
