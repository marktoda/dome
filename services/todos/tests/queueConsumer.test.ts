import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processTodoQueue } from '../src/queueConsumer';
import { TodosService } from '../src/services/todosService';
import { TodoPriority, TodoStatus } from '../src/types';

// Mock the TodosService
vi.mock('../src/services/todosService', () => {
  return {
    TodosService: vi.fn().mockImplementation(() => ({
      processTodoJob: vi.fn().mockResolvedValue({ id: 'mock-todo-id', success: true }),
    })),
  };
});

// Mock the logger
vi.mock('@dome/common', () => {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

describe('processTodoQueue', () => {
  let mockEnv: any;
  let mockTodosService: any;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Create mock env
    mockEnv = {
      DB: {} as D1Database,
    };

    // Get reference to the mocked service instance
    mockTodosService = (TodosService as any).mock.results[0]?.value || {};
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should process direct todo jobs', async () => {
    // Create a batch with direct todo items
    const batch = {
      queue: 'todos',
      messages: [
        {
          id: 'msg1',
          body: {
            userId: 'user123',
            sourceNoteId: 'note123',
            title: 'Direct todo',
            sourceText: 'This is a direct todo',
            created: Date.now(),
            version: 1,
          },
        },
      ],
    };

    // Process the batch
    await processTodoQueue(batch as any, mockEnv);

    // Check if todosService.processTodoJob was called with the correct data
    expect(mockTodosService.processTodoJob).toHaveBeenCalledTimes(1);
    expect(mockTodosService.processTodoJob).toHaveBeenCalledWith(batch.messages[0].body);
  });

  it('should process AI Processor enriched messages', async () => {
    // Create a batch with AI Processor enriched messages
    const batch = {
      queue: 'todos',
      messages: [
        {
          id: 'msg1',
          body: {
            id: 'note123',
            userId: 'user123',
            metadata: {
              todos: [
                { text: 'Todo 1', priority: 'high' },
                { text: 'Todo 2', priority: 'medium' },
              ],
            },
          },
        },
      ],
    };

    // Process the batch
    await processTodoQueue(batch as any, mockEnv);

    // Check if todosService.processTodoJob was called for each todo
    expect(mockTodosService.processTodoJob).toHaveBeenCalledTimes(2);

    // Check the first call arguments
    const firstCallArg = mockTodosService.processTodoJob.mock.calls[0][0];
    expect(firstCallArg).toMatchObject({
      userId: 'user123',
      sourceNoteId: 'note123',
      sourceText: 'Todo 1',
      aiGenerated: true,
      aiSuggestions: {
        priority: TodoPriority.HIGH,
      },
    });

    // Check the second call arguments
    const secondCallArg = mockTodosService.processTodoJob.mock.calls[1][0];
    expect(secondCallArg).toMatchObject({
      userId: 'user123',
      sourceNoteId: 'note123',
      sourceText: 'Todo 2',
      aiGenerated: true,
      aiSuggestions: {
        priority: TodoPriority.MEDIUM,
      },
    });
  });

  it('should handle empty messages gracefully', async () => {
    // Create a batch with an empty message
    const batch = {
      queue: 'todos',
      messages: [
        {
          id: 'msg1',
          body: null,
        },
      ],
    };

    // Process the batch
    await processTodoQueue(batch as any, mockEnv);

    // Check that no todos were processed
    expect(mockTodosService.processTodoJob).not.toHaveBeenCalled();
  });

  it('should handle unknown message formats gracefully', async () => {
    // Create a batch with an unknown message format
    const batch = {
      queue: 'todos',
      messages: [
        {
          id: 'msg1',
          body: {
            foo: 'bar',
          },
        },
      ],
    };

    // Process the batch
    await processTodoQueue(batch as any, mockEnv);

    // Check that no todos were processed
    expect(mockTodosService.processTodoJob).not.toHaveBeenCalled();
  });

  it('should continue processing after an error with one message', async () => {
    // Make the first call throw an error
    mockTodosService.processTodoJob.mockRejectedValueOnce(new Error('Test error'));

    // Create a batch with two messages
    const batch = {
      queue: 'todos',
      messages: [
        {
          id: 'msg1',
          body: {
            userId: 'user123',
            sourceNoteId: 'note123',
            title: 'Will fail',
            sourceText: 'This will fail',
            created: Date.now(),
            version: 1,
          },
        },
        {
          id: 'msg2',
          body: {
            userId: 'user123',
            sourceNoteId: 'note456',
            title: 'Should succeed',
            sourceText: 'This should succeed',
            created: Date.now(),
            version: 1,
          },
        },
      ],
    };

    // Process the batch
    await processTodoQueue(batch as any, mockEnv);

    // The second message should still be processed
    expect(mockTodosService.processTodoJob).toHaveBeenCalledTimes(2);
    expect(mockTodosService.processTodoJob).toHaveBeenLastCalledWith(batch.messages[1].body);
  });
});
