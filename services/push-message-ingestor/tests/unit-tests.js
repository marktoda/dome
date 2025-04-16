/**
 * Unit tests for push-message-ingestor service
 *
 * These tests can be run using Jest or another JavaScript testing framework.
 * They test the core functionality of the service without requiring it to be running.
 */

// Mock the queue binding
const mockQueue = {
  send: jest.fn().mockResolvedValue(undefined),
  sendBatch: jest.fn().mockResolvedValue(undefined),
};

// Import the necessary modules
const { MessageService } = require('../src/services/messageService');
const { MessageController } = require('../src/controllers/messageController');
const {
  validateTelegramMessage,
  validateTelegramMessageBatch,
} = require('../src/models/validators');

// Sample valid message
const validMessage = {
  id: 'msg123',
  timestamp: new Date().toISOString(),
  platform: 'telegram',
  content: 'Hello, this is a test message',
  metadata: {
    chatId: 'chat123',
    messageId: 'telegramMsg123',
    fromUserId: 'user123',
    fromUsername: 'testuser',
  },
};

// Sample invalid message (missing required fields)
const invalidMessage = {
  id: 'msg123',
  timestamp: new Date().toISOString(),
  platform: 'telegram',
  content: 'Hello, this is a test message',
  metadata: {
    fromUserId: 'user123',
    fromUsername: 'testuser',
  },
};

describe('Message Validators', () => {
  test('validateTelegramMessage should validate a valid message', () => {
    const result = validateTelegramMessage(validMessage);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test('validateTelegramMessage should reject an invalid message', () => {
    const result = validateTelegramMessage(invalidMessage);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Chat ID is required in metadata');
    expect(result.errors).toContain('Message ID is required in metadata');
  });

  test('validateTelegramMessageBatch should validate a batch of valid messages', () => {
    const batch = { messages: [validMessage, validMessage] };
    const result = validateTelegramMessageBatch(batch);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test('validateTelegramMessageBatch should reject a batch with invalid messages', () => {
    const batch = { messages: [validMessage, invalidMessage] };
    const result = validateTelegramMessageBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors[0]).toContain('Invalid messages at indexes: 1');
  });

  test('validateTelegramMessageBatch should accept an empty batch', () => {
    const batch = { messages: [] };
    const result = validateTelegramMessageBatch(batch);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });
});

describe('MessageService', () => {
  let messageService;

  beforeEach(() => {
    messageService = new MessageService(mockQueue);
    mockQueue.send.mockClear();
    mockQueue.sendBatch.mockClear();
  });

  test('publishMessage should send a message to the queue', async () => {
    await messageService.publishMessage(validMessage);
    expect(mockQueue.send).toHaveBeenCalledWith(validMessage);
  });

  test('publishMessages should send multiple messages to the queue', async () => {
    const messages = [validMessage, validMessage];
    await messageService.publishMessages(messages);
    expect(mockQueue.sendBatch).toHaveBeenCalledWith(messages);
  });

  test('publishTelegramMessages should validate and publish valid messages', async () => {
    const batch = { messages: [validMessage, validMessage] };
    const result = await messageService.publishTelegramMessages(batch);
    expect(result.success).toBe(true);
    expect(mockQueue.sendBatch).toHaveBeenCalledWith(batch.messages);
  });

  test('publishTelegramMessages should reject invalid messages', async () => {
    const batch = { messages: [validMessage, invalidMessage] };
    const result = await messageService.publishTelegramMessages(batch);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockQueue.sendBatch).not.toHaveBeenCalled();
  });
});

describe('MessageController', () => {
  let messageController;
  let mockContext;

  beforeEach(() => {
    messageController = new MessageController(mockQueue);
    mockContext = {
      req: {
        json: jest.fn(),
      },
      json: jest.fn().mockReturnValue(new Response()),
    };
    mockQueue.send.mockClear();
    mockQueue.sendBatch.mockClear();
  });

  test('publishTelegramMessages should return success for valid messages', async () => {
    const batch = { messages: [validMessage, validMessage] };
    mockContext.req.json.mockResolvedValue(batch);

    await messageController.publishTelegramMessages(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          count: 2,
        }),
      }),
      undefined,
    );
    expect(mockQueue.sendBatch).toHaveBeenCalledWith(batch.messages);
  });

  test('publishTelegramMessages should return error for invalid messages', async () => {
    const batch = { messages: [validMessage, invalidMessage] };
    mockContext.req.json.mockResolvedValue(batch);

    await messageController.publishTelegramMessages(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      }),
      400,
    );
    expect(mockQueue.sendBatch).not.toHaveBeenCalled();
  });

  test('publishTelegramMessages should handle empty message array', async () => {
    const batch = { messages: [] };
    mockContext.req.json.mockResolvedValue(batch);

    await messageController.publishTelegramMessages(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          count: 0,
        }),
      }),
      undefined,
    );
  });

  test('publishTelegramMessages should handle JSON parsing errors', async () => {
    mockContext.req.json.mockRejectedValue(new Error('Invalid JSON'));

    await messageController.publishTelegramMessages(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'SERVER_ERROR',
        }),
      }),
      500,
    );
  });
});
