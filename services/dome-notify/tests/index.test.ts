import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';
import { Event, EventSchema } from 'common';
import { NotificationService } from '../src/services/notificationService';
import { EventHandlerRegistry } from '../src/handlers/eventHandlers';

// Mock notification service
vi.mock('../src/services/notificationService', () => ({
  NotificationService: vi.fn().mockImplementation(() => ({
    addChannel: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  })),
  EmailNotificationChannel: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
  SlackNotificationChannel: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock event handlers
vi.mock('../src/handlers/eventHandlers', () => ({
  EventHandlerRegistry: vi.fn().mockImplementation(() => ({
    registerHandler: vi.fn(),
    handleEvent: vi.fn().mockResolvedValue(undefined),
  })),
  ReminderDueEventHandler: vi.fn().mockImplementation(() => ({
    canHandle: vi.fn().mockReturnValue(true),
    handle: vi.fn().mockResolvedValue(undefined),
  })),
  IngestionCompleteEventHandler: vi.fn().mockImplementation(() => ({
    canHandle: vi.fn().mockReturnValue(true),
    handle: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock common module
vi.mock('common', () => ({
  Event: {},
  EventSchema: {
    parse: vi.fn().mockImplementation((data) => data),
  },
}));

// Mock environment
const createMockEnv = () => ({
  D1_DATABASE: {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
  },
  ENVIRONMENT: 'test',
  VERSION: '0.1.0',
  MAIL_FROM: 'test@example.com',
  MAIL_FROM_NAME: 'Test Notifications',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/test',
});

// Mock message batch
const createMockMessageBatch = () => ({
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
});

// Mock execution context
const createMockContext = () => ({
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
});

describe('dome-notify worker', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let mockMessageBatch: ReturnType<typeof createMockMessageBatch>;
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    mockMessageBatch = createMockMessageBatch();
    mockContext = createMockContext();
    vi.clearAllMocks();
  });

  describe('queue handler', () => {
    it('should initialize notification service with configured channels', async () => {
      // Act
      await worker.queue(mockMessageBatch, mockEnv, mockContext);

      // Assert
      expect(NotificationService).toHaveBeenCalled();
      
      const notificationServiceInstance = (NotificationService as any).mock.results[0].value;
      expect(notificationServiceInstance.addChannel).toHaveBeenCalledTimes(2); // Email and Slack
    });

    it('should initialize event handler registry with all handlers', async () => {
      // Act
      await worker.queue(mockMessageBatch, mockEnv, mockContext);

      // Assert
      expect(EventHandlerRegistry).toHaveBeenCalled();
      
      const eventHandlerRegistryInstance = (EventHandlerRegistry as any).mock.results[0].value;
      expect(eventHandlerRegistryInstance.registerHandler).toHaveBeenCalledTimes(2); // ReminderDue and IngestionComplete
    });

    it('should process each message in the batch', async () => {
      // Act
      await worker.queue(mockMessageBatch, mockEnv, mockContext);

      // Assert
      expect(EventSchema.parse).toHaveBeenCalledTimes(1);
      
      const eventHandlerRegistryInstance = (EventHandlerRegistry as any).mock.results[0].value;
      expect(eventHandlerRegistryInstance.handleEvent).toHaveBeenCalledTimes(1);
      
      expect(mockMessageBatch.ack).toHaveBeenCalledTimes(1);
      expect(mockMessageBatch.ack).toHaveBeenCalledWith('msg1');
    });

    it('should handle errors in message processing', async () => {
      // Arrange
      // Directly modify the mock implementation
      vi.mocked(EventHandlerRegistry).mockImplementation(() => ({
        registerHandler: vi.fn(),
        handleEvent: vi.fn().mockRejectedValue(new Error('Handler error')),
      }));

      // Act
      await worker.queue(mockMessageBatch, mockEnv, mockContext);

      // Assert
      expect(mockMessageBatch.ack).toHaveBeenCalledTimes(1);
      expect(mockMessageBatch.ack).toHaveBeenCalledWith('msg1');
    });

    it('should handle invalid JSON in message body', async () => {
      // Arrange
      mockMessageBatch.messages[0].body = 'invalid json';

      // Act
      await worker.queue(mockMessageBatch, mockEnv, mockContext);

      // Assert
      expect(console.error).toHaveBeenCalled;
      expect(mockMessageBatch.ack).toHaveBeenCalledTimes(1);
      expect(mockMessageBatch.ack).toHaveBeenCalledWith('msg1');
    });

    it('should handle empty message batch', async () => {
      // Arrange
      mockMessageBatch.messages = [];

      // Act
      await worker.queue(mockMessageBatch, mockEnv, mockContext);

      // Assert
      expect(EventSchema.parse).not.toHaveBeenCalled();
      
      const eventHandlerRegistryInstance = (EventHandlerRegistry as any).mock.results[0].value;
      expect(eventHandlerRegistryInstance.handleEvent).not.toHaveBeenCalled();
    });
  });
});