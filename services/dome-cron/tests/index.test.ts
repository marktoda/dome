import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';
import { QueueService } from '@dome/common';

// Mock environment
const createMockEnv = () => ({
  D1_DATABASE: {
    prepare: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({
      results: [
        {
          reminder_id: '123e4567-e89b-12d3-a456-426614174001',
          task_id: '123e4567-e89b-12d3-a456-426614174002',
          user_id: '123e4567-e89b-12d3-a456-426614174003',
          title: 'Test Reminder',
          description: 'This is a test reminder',
          remind_at: new Date().toISOString(),
          priority: 'medium',
        },
      ],
      success: true,
    }),
  },
  EVENTS: {
    send: vi.fn().mockResolvedValue(undefined),
  },
  ENVIRONMENT: 'test',
  VERSION: '0.1.0',
});

// Mock execution context
const createMockContext = () => ({
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
});

// Mock scheduled event
const createMockScheduledEvent = () => ({
  cron: '*/5 * * * *',
  scheduledTime: Date.now(),
});

// Mock QueueService
vi.mock('@dome/common', () => ({
  QueueService: vi.fn().mockImplementation(() => ({
    publishEvent: vi.fn().mockResolvedValue(undefined),
    publishEvents: vi.fn().mockResolvedValue(undefined),
  })),
  createReminderDueEvent: vi.fn().mockImplementation(data => ({
    id: '123e4567-e89b-12d3-a456-426614174000',
    timestamp: new Date().toISOString(),
    type: 'reminder_due',
    version: '1.0',
    data,
    attempts: 0,
  })),
  Event: {},
  EventSchema: {
    parse: vi.fn().mockImplementation(data => data),
  },
}));

describe('dome-cron worker', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let mockContext: ReturnType<typeof createMockContext>;
  let mockScheduledEvent: ReturnType<typeof createMockScheduledEvent>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    mockContext = createMockContext();
    mockScheduledEvent = createMockScheduledEvent();
    vi.clearAllMocks();
  });

  describe('scheduled handler', () => {
    it('should query for due reminders and publish events to the queue', async () => {
      // Act
      await worker.scheduled(mockScheduledEvent, mockEnv as any, mockContext);

      // Assert
      expect(mockEnv.D1_DATABASE.prepare).toHaveBeenCalled();
      expect(mockEnv.D1_DATABASE.all).toHaveBeenCalled();

      // Verify QueueService was initialized with the correct parameters
      expect(QueueService).toHaveBeenCalledWith({
        queueBinding: mockEnv.EVENTS,
        maxRetries: 3,
      });

      // Verify events were published
      const queueServiceInstance = (QueueService as any).mock.results[0].value;
      expect(queueServiceInstance.publishEvents).toHaveBeenCalled();

      // Verify the correct number of events were published
      const publishEventsCall = queueServiceInstance.publishEvents.mock.calls[0][0];
      expect(publishEventsCall.length).toBe(1);
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const dbError = new Error('Database error');
      mockEnv.D1_DATABASE.all = vi.fn().mockRejectedValue(dbError);

      // Mock waitUntil to properly handle the rejection
      let capturedPromise: Promise<any> | null = null;
      mockContext.waitUntil = vi.fn().mockImplementation(promise => {
        capturedPromise = promise;
        return Promise.resolve();
      });

      // Act & Assert
      await expect(
        worker.scheduled(mockScheduledEvent, mockEnv as any, mockContext),
      ).rejects.toThrow('Database error');

      // Verify waitUntil was called
      expect(mockContext.waitUntil).toHaveBeenCalled();

      // If capturedPromise was set, we need to catch its rejection to prevent unhandled rejection
      if (capturedPromise) {
        try {
          await capturedPromise;
        } catch (error) {
          // Expected to throw, we're just catching it to prevent unhandled rejection
          expect((error as Error).message).toBe('Database error');
        }
      }
    });

    it('should handle empty result sets', async () => {
      // Arrange
      mockEnv.D1_DATABASE.all = vi.fn().mockResolvedValue({
        results: [],
        success: true,
      });

      // Act
      await worker.scheduled(mockScheduledEvent, mockEnv as any, mockContext);

      // Assert
      const queueServiceInstance = (QueueService as any).mock.results[0].value;
      expect(queueServiceInstance.publishEvents).not.toHaveBeenCalled();
    });

    it('should process reminders in batches when there are many results', async () => {
      // Arrange
      const mockResults = Array(600)
        .fill(0)
        .map((_, i) => ({
          reminder_id: `reminder-${i}`,
          task_id: `task-${i}`,
          user_id: 'user-1',
          title: `Reminder ${i}`,
          description: `Description ${i}`,
          remind_at: new Date().toISOString(),
          priority: 'medium',
        }));

      // First call returns 500 results, second call returns 100 results
      mockEnv.D1_DATABASE.all = vi
        .fn()
        .mockResolvedValueOnce({
          results: mockResults.slice(0, 500),
          success: true,
        })
        .mockResolvedValueOnce({
          results: mockResults.slice(500),
          success: true,
        })
        .mockResolvedValueOnce({
          results: [],
          success: true,
        });

      // Act
      await worker.scheduled(mockScheduledEvent, mockEnv as any, mockContext);

      // Assert
      expect(mockEnv.D1_DATABASE.all).toHaveBeenCalledTimes(3);

      const queueServiceInstance = (QueueService as any).mock.results[0].value;
      expect(queueServiceInstance.publishEvents).toHaveBeenCalledTimes(2);

      // First batch should have 500 events
      const firstBatchEvents = queueServiceInstance.publishEvents.mock.calls[0][0];
      expect(firstBatchEvents.length).toBe(500);

      // Second batch should have 100 events
      const secondBatchEvents = queueServiceInstance.publishEvents.mock.calls[1][0];
      expect(secondBatchEvents.length).toBe(100);
    });
  });
});
