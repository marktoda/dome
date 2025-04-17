import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueService, Queue } from './queueService';
import { QueueError } from '../errors/ServiceError';
import { Event } from '../types/events';

// Mock Queue implementation
const createMockQueue = (): Queue => ({
  send: vi.fn().mockResolvedValue(undefined),
});

describe('QueueService', () => {
  let queueService: QueueService;
  let mockQueue: Queue;

  beforeEach(() => {
    mockQueue = createMockQueue();
    queueService = new QueueService({
      queueBinding: mockQueue,
      maxRetries: 3,
    });
  });

  describe('publishEvent', () => {
    it('should publish a valid event to the queue', async () => {
      // Arrange
      const event: Event = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        timestamp: new Date().toISOString(),
        type: 'reminder_due',
        version: '1.0',
        data: {
          reminderId: '123e4567-e89b-12d3-a456-426614174001',
          taskId: '123e4567-e89b-12d3-a456-426614174002',
          userId: '123e4567-e89b-12d3-a456-426614174003',
          title: 'Test Reminder',
          description: 'This is a test reminder',
          dueAt: new Date().toISOString(),
          priority: 'medium',
        },
        attempts: 0,
      };

      // Act
      await queueService.publishEvent(event);

      // Assert
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
      expect(mockQueue.send).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it('should throw QueueError when queue.send fails', async () => {
      // Arrange
      const event: Event = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        timestamp: new Date().toISOString(),
        type: 'reminder_due',
        version: '1.0',
        data: {
          reminderId: '123e4567-e89b-12d3-a456-426614174001',
          taskId: '123e4567-e89b-12d3-a456-426614174002',
          userId: '123e4567-e89b-12d3-a456-426614174003',
          title: 'Test Reminder',
          description: 'This is a test reminder',
          dueAt: new Date().toISOString(),
          priority: 'medium',
        },
        attempts: 0,
      };

      // Mock queue.send to throw an error
      mockQueue.send = vi.fn().mockRejectedValue(new Error('Queue error'));

      // Act & Assert
      await expect(queueService.publishEvent(event)).rejects.toThrow(QueueError);
    });
  });

  describe('publishEvents', () => {
    it('should publish multiple events to the queue', async () => {
      // Arrange
      const events: Event[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          timestamp: new Date().toISOString(),
          type: 'reminder_due',
          version: '1.0',
          data: {
            reminderId: '123e4567-e89b-12d3-a456-426614174001',
            taskId: '123e4567-e89b-12d3-a456-426614174002',
            userId: '123e4567-e89b-12d3-a456-426614174003',
            title: 'Test Reminder 1',
            description: 'This is test reminder 1',
            dueAt: new Date().toISOString(),
            priority: 'medium',
          },
          attempts: 0,
        },
        {
          id: '223e4567-e89b-12d3-a456-426614174000',
          timestamp: new Date().toISOString(),
          type: 'reminder_due',
          version: '1.0',
          data: {
            reminderId: '223e4567-e89b-12d3-a456-426614174001',
            taskId: '223e4567-e89b-12d3-a456-426614174002',
            userId: '223e4567-e89b-12d3-a456-426614174003',
            title: 'Test Reminder 2',
            description: 'This is test reminder 2',
            dueAt: new Date().toISOString(),
            priority: 'high',
          },
          attempts: 0,
        },
      ];

      // Act
      await queueService.publishEvents(events);

      // Assert
      expect(mockQueue.send).toHaveBeenCalledTimes(2);
      expect(mockQueue.send).toHaveBeenCalledWith(JSON.stringify(events[0]));
      expect(mockQueue.send).toHaveBeenCalledWith(JSON.stringify(events[1]));
    });

    it('should throw QueueError when queue.send fails for multiple events', async () => {
      // Arrange
      const events: Event[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          timestamp: new Date().toISOString(),
          type: 'reminder_due',
          version: '1.0',
          data: {
            reminderId: '123e4567-e89b-12d3-a456-426614174001',
            taskId: '123e4567-e89b-12d3-a456-426614174002',
            userId: '123e4567-e89b-12d3-a456-426614174003',
            title: 'Test Reminder 1',
            description: 'This is test reminder 1',
            dueAt: new Date().toISOString(),
            priority: 'medium',
          },
          attempts: 0,
        },
      ];

      // Mock queue.send to throw an error
      mockQueue.send = vi.fn().mockRejectedValue(new Error('Queue error'));

      // Act & Assert
      await expect(queueService.publishEvents(events)).rejects.toThrow(QueueError);
    });
  });

  describe('processMessage', () => {
    it('should process a message batch and call the handler for each message', async () => {
      // Arrange
      const mockHandler = vi.fn().mockResolvedValue(undefined);
      const mockMessageBatch = {
        messages: [
          {
            id: 'msg1',
            body: JSON.stringify({
              id: '123e4567-e89b-12d3-a456-426614174000',
              timestamp: new Date().toISOString(),
              type: 'reminder_due',
              version: '1.0',
              data: {
                reminderId: '123e4567-e89b-12d3-a456-426614174001',
                taskId: '123e4567-e89b-12d3-a456-426614174002',
                userId: '123e4567-e89b-12d3-a456-426614174003',
                title: 'Test Reminder',
                description: 'This is a test reminder',
                dueAt: new Date().toISOString(),
                priority: 'medium',
              },
              attempts: 0,
            }),
            timestamp: Date.now(),
          },
        ],
        ack: vi.fn(),
      };

      // Act
      await queueService.processMessage(mockMessageBatch, mockHandler);

      // Assert
      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockMessageBatch.ack).toHaveBeenCalledTimes(1);
      expect(mockMessageBatch.ack).toHaveBeenCalledWith('msg1');
    });

    it('should handle errors in message processing and retry', async () => {
      // Arrange
      const mockHandler = vi.fn().mockRejectedValue(new Error('Handler error'));
      const event = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        timestamp: new Date().toISOString(),
        type: 'reminder_due',
        version: '1.0',
        data: {
          reminderId: '123e4567-e89b-12d3-a456-426614174001',
          taskId: '123e4567-e89b-12d3-a456-426614174002',
          userId: '123e4567-e89b-12d3-a456-426614174003',
          title: 'Test Reminder',
          description: 'This is a test reminder',
          dueAt: new Date().toISOString(),
          priority: 'medium',
        },
        attempts: 0,
      };
      
      const mockMessageBatch = {
        messages: [
          {
            id: 'msg1',
            body: JSON.stringify(event),
            timestamp: Date.now(),
          },
        ],
        ack: vi.fn(),
      };

      // Act
      await queueService.processMessage(mockMessageBatch, mockHandler);

      // Assert
      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
      // Check that the event was re-published with incremented attempts
      const sendFn = vi.mocked(mockQueue.send);
      const sentEvent = JSON.parse(sendFn.mock.calls[0][0]);
      expect(sentEvent.attempts).toBe(1);
      expect(mockMessageBatch.ack).toHaveBeenCalledTimes(1);
    });
  });
});