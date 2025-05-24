import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodosService } from '../src/services/todosService';
import { ValidationError } from '@dome/common/errors';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  createServiceMetrics: vi.fn().mockReturnValue({
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  }),
}));

vi.mock('../src/db/todosRepository', () => ({
  TodosRepository: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    findById: vi.fn(),
    findByUserId: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findAll: vi.fn(),
  })),
}));

vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn().mockImplementation((_, fn) => fn()),
}));

describe('TodosService', () => {
  let todosService: TodosService;
  let mockRepository: any;
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      DB: {},
    };

    mockRepository = {
      create: vi.fn(),
      findById: vi.fn(),
      findByUserId: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findAll: vi.fn(),
    };

    todosService = new TodosService(mockEnv);
    (todosService as any).repository = mockRepository;
    vi.clearAllMocks();
  });

  describe('createTodo', () => {
    it('should create todo successfully', async () => {
      const todoData = {
        title: 'Test Todo',
        description: 'Test description',
        userId: 'user-123',
      };

      const createdTodo = {
        id: 'todo-123',
        ...todoData,
        completed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.create.mockResolvedValueOnce(createdTodo);

      const result = await todosService.createTodo(todoData);

      expect(result).toMatchObject(createdTodo);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Todo',
          description: 'Test description',
          userId: 'user-123',
          completed: false,
        })
      );
    });

    it('should handle missing title', async () => {
      const invalidTodoData = {
        description: 'Test description',
        userId: 'user-123',
      };

      await expect(todosService.createTodo(invalidTodoData as any))
        .rejects.toThrow(ValidationError);
    });

    it('should handle missing userId', async () => {
      const invalidTodoData = {
        title: 'Test Todo',
        description: 'Test description',
      };

      await expect(todosService.createTodo(invalidTodoData as any))
        .rejects.toThrow(ValidationError);
    });

    it('should handle repository errors', async () => {
      const todoData = {
        title: 'Test Todo',
        description: 'Test description',
        userId: 'user-123',
      };

      mockRepository.create.mockRejectedValueOnce(new Error('Database error'));

      await expect(todosService.createTodo(todoData))
        .rejects.toThrow('Database error');
    });
  });

  describe('getTodo', () => {
    it('should retrieve todo by id', async () => {
      const todoId = 'todo-123';
      const userId = 'user-123';
      const mockTodo = {
        id: todoId,
        title: 'Test Todo',
        description: 'Test description',
        userId,
        completed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.findById.mockResolvedValueOnce(mockTodo);

      const result = await todosService.getTodo(todoId, userId);

      expect(result).toMatchObject(mockTodo);
      expect(mockRepository.findById).toHaveBeenCalledWith(todoId);
    });

    it('should return null for non-existent todo', async () => {
      const todoId = 'non-existent';
      const userId = 'user-123';

      mockRepository.findById.mockResolvedValueOnce(null);

      const result = await todosService.getTodo(todoId, userId);

      expect(result).toBeNull();
    });

    it('should prevent access to other users todos', async () => {
      const todoId = 'todo-123';
      const userId = 'user-123';
      const otherUserId = 'user-456';
      
      const otherUserTodo = {
        id: todoId,
        title: 'Other User Todo',
        userId: otherUserId,
        completed: false,
      };

      mockRepository.findById.mockResolvedValueOnce(otherUserTodo);

      const result = await todosService.getTodo(todoId, userId);

      expect(result).toBeNull();
    });
  });

  describe('getUserTodos', () => {
    it('should retrieve all todos for user', async () => {
      const userId = 'user-123';
      const mockTodos = [
        {
          id: 'todo-1',
          title: 'Todo 1',
          userId,
          completed: false,
        },
        {
          id: 'todo-2',
          title: 'Todo 2',
          userId,
          completed: true,
        },
      ];

      mockRepository.findByUserId.mockResolvedValueOnce(mockTodos);

      const result = await todosService.getUserTodos(userId);

      expect(result).toHaveLength(2);
      expect(result).toEqual(mockTodos);
      expect(mockRepository.findByUserId).toHaveBeenCalledWith(userId);
    });

    it('should return empty array for user with no todos', async () => {
      const userId = 'user-with-no-todos';

      mockRepository.findByUserId.mockResolvedValueOnce([]);

      const result = await todosService.getUserTodos(userId);

      expect(result).toEqual([]);
    });
  });

  describe('updateTodo', () => {
    it('should update todo successfully', async () => {
      const todoId = 'todo-123';
      const userId = 'user-123';
      const updateData = {
        title: 'Updated Todo',
        completed: true,
      };

      const existingTodo = {
        id: todoId,
        title: 'Original Todo',
        userId,
        completed: false,
      };

      const updatedTodo = {
        ...existingTodo,
        ...updateData,
        updatedAt: new Date(),
      };

      mockRepository.findById.mockResolvedValueOnce(existingTodo);
      mockRepository.update.mockResolvedValueOnce(updatedTodo);

      const result = await todosService.updateTodo(todoId, userId, updateData);

      expect(result).toMatchObject(updatedTodo);
      expect(mockRepository.update).toHaveBeenCalledWith(
        todoId,
        expect.objectContaining(updateData)
      );
    });

    it('should handle non-existent todo update', async () => {
      const todoId = 'non-existent';
      const userId = 'user-123';
      const updateData = { title: 'Updated' };

      mockRepository.findById.mockResolvedValueOnce(null);

      const result = await todosService.updateTodo(todoId, userId, updateData);

      expect(result).toBeNull();
      expect(mockRepository.update).not.toHaveBeenCalled();
    });

    it('should prevent updating other users todos', async () => {
      const todoId = 'todo-123';
      const userId = 'user-123';
      const otherUserId = 'user-456';
      const updateData = { title: 'Hacked' };

      const otherUserTodo = {
        id: todoId,
        title: 'Other User Todo',
        userId: otherUserId,
        completed: false,
      };

      mockRepository.findById.mockResolvedValueOnce(otherUserTodo);

      const result = await todosService.updateTodo(todoId, userId, updateData);

      expect(result).toBeNull();
      expect(mockRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteTodo', () => {
    it('should delete todo successfully', async () => {
      const todoId = 'todo-123';
      const userId = 'user-123';

      const existingTodo = {
        id: todoId,
        title: 'Todo to Delete',
        userId,
        completed: false,
      };

      mockRepository.findById.mockResolvedValueOnce(existingTodo);
      mockRepository.delete.mockResolvedValueOnce(true);

      const result = await todosService.deleteTodo(todoId, userId);

      expect(result).toBe(true);
      expect(mockRepository.delete).toHaveBeenCalledWith(todoId);
    });

    it('should handle non-existent todo deletion', async () => {
      const todoId = 'non-existent';
      const userId = 'user-123';

      mockRepository.findById.mockResolvedValueOnce(null);

      const result = await todosService.deleteTodo(todoId, userId);

      expect(result).toBe(false);
      expect(mockRepository.delete).not.toHaveBeenCalled();
    });

    it('should prevent deleting other users todos', async () => {
      const todoId = 'todo-123';
      const userId = 'user-123';
      const otherUserId = 'user-456';

      const otherUserTodo = {
        id: todoId,
        title: 'Other User Todo',
        userId: otherUserId,
        completed: false,
      };

      mockRepository.findById.mockResolvedValueOnce(otherUserTodo);

      const result = await todosService.deleteTodo(todoId, userId);

      expect(result).toBe(false);
      expect(mockRepository.delete).not.toHaveBeenCalled();
    });
  });
});