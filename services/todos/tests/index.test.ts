/**
 * Tests for the main Todos service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Todos from '../src/index';
import { TodoStatus, TodoPriority, TodoJob } from '../src/types';
import { getLogger } from '@dome/logging';

// Define types needed for testing
interface Env {
  DB: D1Database;
  TODOS_QUEUE: Queue<TodoJob>;
  ENVIRONMENT: string;
  VERSION: string;
}

// Use any for Message to avoid type conflicts with the actual Message type
interface TestMessage<T> {
  id: string;
  timestamp: number;
  body: T;
  attempts: number;
  retry: () => void;
  ack: () => void;
}

// Use any for MessageBatch to avoid type conflicts with the actual MessageBatch type
interface TestMessageBatch<T> {
  messages: readonly TestMessage<T>[];
  queue: string;
  retryAll: () => void;
  ackAll: () => void;
}

// Mock dependencies
vi.mock('@dome/logging', () => {
  const mockMetricsService = {
    increment: vi.fn(),
    decrement: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(() => 100),
    })),
    trackOperation: vi.fn((name, fn) => fn()),
    getCounter: vi.fn(),
    getGauge: vi.fn(),
    reset: vi.fn(),
  };

  return {
    withLogger: vi.fn((_, fn) => fn()),
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
    logMetric: vi.fn(),
    createTimer: vi.fn(() => ({
      stop: vi.fn(() => 100),
    })),
    metrics: mockMetricsService,
    createServiceMetrics: vi.fn(() => mockMetricsService),
  };
});

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor() {}
    fetch() {}
    queue() {}
  },
}));

// Mock TodosService
vi.mock('../src/services/todosService', () => {
  return {
    TodosService: vi.fn().mockImplementation(() => ({
      createTodo: vi.fn().mockResolvedValue({ id: 'todo-123', success: true }),
      getTodo: vi.fn().mockResolvedValue({
        id: 'todo-123',
        userId: 'user-123',
        title: 'Test Todo',
        status: 'pending',
        priority: 'medium',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        aiGenerated: false,
      }),
      listTodos: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'todo-123',
            userId: 'user-123',
            title: 'Test Todo',
            status: 'pending',
            priority: 'medium',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            aiGenerated: false,
          },
        ],
        nextCursor: undefined,
        totalCount: 1,
      }),
      updateTodo: vi.fn().mockResolvedValue({ success: true }),
      deleteTodo: vi.fn().mockResolvedValue({ success: true }),
      batchUpdateTodos: vi.fn().mockResolvedValue({ success: true, updatedCount: 2 }),
      getTodoStats: vi.fn().mockResolvedValue({
        totalCount: 10,
        byStatus: {
          pending: 5,
          in_progress: 3,
          completed: 2,
          cancelled: 0,
        },
        byPriority: {
          low: 2,
          medium: 5,
          high: 2,
          urgent: 1,
        },
        byCategory: {
          work: 5,
          personal: 5,
        },
        overdue: 1,
        dueToday: 2,
        dueThisWeek: 5,
      }),
      processTodoJob: vi.fn().mockResolvedValue({ id: 'todo-123', success: true }),
    })),
  };
});

describe('Todos Service', () => {
  let todos: Todos;
  let mockEnv: Env;

  // Test data
  const testTodoInput = {
    userId: 'user-123',
    title: 'Test Todo',
    description: 'This is a test todo',
    priority: TodoPriority.HIGH,
  };

  const testTodoJob: TodoJob = {
    userId: 'user-123',
    sourceNoteId: 'note-456',
    sourceText: 'This is a test todo from note',
    title: 'Test Todo from note',
    created: Date.now(),
    version: 1,
  };

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment with D1Database
    mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue({}),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
        batch: vi.fn().mockImplementation((stmts: any[]) => Promise.all(stmts.map((s: any) => s.run()))),
        exec: vi.fn().mockResolvedValue({}),
      } as unknown as D1Database,
      TODOS_QUEUE: {
        send: vi.fn(),
      } as unknown as Queue<TodoJob>,
      ENVIRONMENT: 'test',
      VERSION: '1.0.0',
    };

    // Create instance with mock env
    // We need to extend the class to test it
    class TestTodos extends Todos {
      constructor() {
        // @ts-ignore - We're mocking the constructor for testing
        super();
      }
    }

    todos = new TestTodos();
    // @ts-ignore - Accessing protected property for testing
    todos.env = mockEnv;
  });

  describe('createTodo', () => {
    it('should create a todo successfully', async () => {
      // Act
      const result = await todos.createTodo(testTodoInput);

      // Assert
      expect(result).toEqual({ id: 'todo-123', success: true });
      expect(getLogger().debug).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'create_todo',
        }),
        expect.any(String)
      );
    });

    it('should handle errors during creation', async () => {
      // Arrange
      const error = new Error('Creation error');
      const { TodosService } = await import('../src/services/todosService');
      const mockTodosService = (TodosService as any).mock.results[0].value;
      mockTodosService.createTodo.mockRejectedValueOnce(error);

      // Act & Assert
      await expect(todos.createTodo(testTodoInput)).rejects.toThrow();
      expect(getLogger().error).toHaveBeenCalled();
    });
  });

  describe('getTodo', () => {
    it('should get a todo by ID successfully', async () => {
      // Act
      const result = await todos.getTodo('todo-123');

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          id: 'todo-123',
          userId: 'user-123',
          title: 'Test Todo',
        })
      );
    });
  });

  describe('listTodos', () => {
    it('should list todos with filter and pagination', async () => {
      // Act
      const result = await todos.listTodos({ userId: 'user-123' }, { limit: 10 });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });
  });

  describe('updateTodo', () => {
    it('should update a todo successfully', async () => {
      // Act
      const result = await todos.updateTodo('todo-123', {
        status: TodoStatus.COMPLETED,
      });

      // Assert
      expect(result).toEqual({ success: true });
    });
  });

  describe('deleteTodo', () => {
    it('should delete a todo successfully', async () => {
      // Act
      const result = await todos.deleteTodo('todo-123');

      // Assert
      expect(result).toEqual({ success: true });
    });
  });

  describe('batchUpdateTodos', () => {
    it('should batch update todos successfully', async () => {
      // Act
      const result = await todos.batchUpdateTodos(['todo-123', 'todo-456'], {
        status: TodoStatus.COMPLETED,
      });

      // Assert
      expect(result).toEqual({ success: true, updatedCount: 2 });
    });
  });

  describe('stats', () => {
    it('should return todo statistics for a user', async () => {
      // Act
      const result = await todos.stats('user-123');

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          totalCount: 10,
          byStatus: expect.any(Object),
          byPriority: expect.any(Object),
        })
      );
    });
  });

  describe('queue', () => {
    it('should process a batch of todo jobs', async () => {
      // Arrange
      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: testTodoJob,
            attempts: 1,
            retry: vi.fn(),
            ack: vi.fn(),
          },
        ],
        queue: 'todos-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Act
      await todos.queue(mockBatch);

      // Assert
      const { TodosService } = await import('../src/services/todosService');
      const mockTodosService = (TodosService as any).mock.results[0].value;
      expect(mockTodosService.processTodoJob).toHaveBeenCalledWith(testTodoJob);
    });

    it('should handle errors during queue processing', async () => {
      // Arrange
      const error = new Error('Processing error');
      const { TodosService } = await import('../src/services/todosService');
      const mockTodosService = (TodosService as any).mock.results[0].value;
      mockTodosService.processTodoJob.mockRejectedValueOnce(error);

      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: testTodoJob,
            attempts: 1,
            retry: vi.fn(),
            ack: vi.fn(),
          },
        ],
        queue: 'todos-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Act
      await todos.queue(mockBatch);

      // Assert
      expect(getLogger().error).toHaveBeenCalled();
    });
  });
});
