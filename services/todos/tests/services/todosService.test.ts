import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TodosService } from '../../src/services/todosService';
import { TodoStatus, TodoPriority, CreateTodoInput, TodoJob } from '../../src/types';

// Mock the D1 database
const mockTodo = {
  id: 'todo_123456789012',
  userId: 'user123',
  title: 'Test Todo',
  description: 'This is a test todo',
  status: TodoStatus.PENDING,
  priority: TodoPriority.MEDIUM,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  aiGenerated: false,
};

const mockDb = {
  prepare: vi.fn(() => ({
    bind: vi.fn(() => ({
      run: vi.fn(() => ({ success: true })),
      first: vi.fn(() => mockTodo),
      all: vi.fn(() => ({ results: [mockTodo] })),
    })),
  })),
} as unknown as D1Database;

// Mock the getLogger function
vi.mock('logging', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TodosService', () => {
  let todosService: TodosService;

  beforeEach(() => {
    todosService = new TodosService(mockDb);
    vi.clearAllMocks();
  });

  describe('createTodo', () => {
    it('should create a todo successfully', async () => {
      const todoInput: CreateTodoInput = {
        userId: 'user123',
        title: 'Test Todo',
        description: 'This is a test todo',
        priority: TodoPriority.MEDIUM,
      };

      const result = await todosService.createTodo(todoInput);

      expect(result).toEqual({
        id: expect.any(String),
        success: true,
      });
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('should throw an error if title is empty', async () => {
      const todoInput: CreateTodoInput = {
        userId: 'user123',
        title: '',
        description: 'This is a test todo',
      };

      await expect(todosService.createTodo(todoInput)).rejects.toThrow();
    });
  });

  describe('getTodo', () => {
    it('should get a todo by ID', async () => {
      const result = await todosService.getTodo('todo_123456789012');

      expect(result).toEqual(mockTodo);
      expect(mockDb.prepare).toHaveBeenCalled();
    });
  });

  describe('listTodos', () => {
    it('should list todos with filtering', async () => {
      const filter = {
        userId: 'user123',
        status: TodoStatus.PENDING,
      };

      const pagination = {
        limit: 10,
      };

      const result = await todosService.listTodos(filter, pagination);

      expect(result).toEqual({
        items: [mockTodo],
        nextCursor: undefined,
        totalCount: undefined,
      });
      expect(mockDb.prepare).toHaveBeenCalled();
    });
  });

  describe('processTodoJob', () => {
    it('should process a todo job from the queue', async () => {
      const job: TodoJob = {
        userId: 'user123',
        sourceNoteId: 'note123',
        sourceText: 'This is a test note with a todo: Test Todo',
        title: 'Test Todo',
        description: 'This is a test todo',
        created: Date.now(),
        version: 1,
        aiSuggestions: {
          priority: TodoPriority.HIGH,
          dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
          estimatedEffort: '1h',
        },
      };

      // Spy on the createTodo method
      const createTodoSpy = vi.spyOn(todosService, 'createTodo');
      createTodoSpy.mockResolvedValue({ id: 'todo_123456789012', success: true });

      const result = await todosService.processTodoJob(job);

      expect(result).toEqual({
        id: 'todo_123456789012',
        success: true,
      });
      expect(createTodoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: job.userId,
          title: job.title,
          description: job.description,
          priority: job.aiSuggestions?.priority,
          sourceNoteId: job.sourceNoteId,
          aiGenerated: true,
        }),
      );
    });
  });
});
