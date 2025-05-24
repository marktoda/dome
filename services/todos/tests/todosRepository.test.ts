import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodosRepository } from '../src/db/todosRepository';

// Mock Drizzle ORM
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock('../src/db/schema', () => ({
  todos: {
    id: 'id',
    title: 'title',
    description: 'description',
    userId: 'userId',
    completed: 'completed',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));

describe('TodosRepository', () => {
  let todosRepository: TodosRepository;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      execute: vi.fn(),
      get: vi.fn(),
      all: vi.fn(),
    };

    todosRepository = new TodosRepository(mockDb);
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new todo', async () => {
      const todoData = {
        title: 'Test Todo',
        description: 'Test description',
        userId: 'user-123',
        completed: false,
      };

      const createdTodo = {
        id: 'todo-123',
        ...todoData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.execute.mockResolvedValueOnce([createdTodo]);

      const result = await todosRepository.create(todoData);

      expect(result).toMatchObject(createdTodo);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining(todoData)
      );
    });

    it('should handle database errors during creation', async () => {
      const todoData = {
        title: 'Test Todo',
        description: 'Test description',
        userId: 'user-123',
        completed: false,
      };

      mockDb.execute.mockRejectedValueOnce(new Error('Database constraint violation'));

      await expect(todosRepository.create(todoData))
        .rejects.toThrow('Database constraint violation');
    });
  });

  describe('findById', () => {
    it('should find todo by id', async () => {
      const todoId = 'todo-123';
      const mockTodo = {
        id: todoId,
        title: 'Test Todo',
        description: 'Test description',
        userId: 'user-123',
        completed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.get.mockResolvedValueOnce(mockTodo);

      const result = await todosRepository.findById(todoId);

      expect(result).toMatchObject(mockTodo);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it('should return null for non-existent todo', async () => {
      const todoId = 'non-existent';

      mockDb.get.mockResolvedValueOnce(null);

      const result = await todosRepository.findById(todoId);

      expect(result).toBeNull();
    });

    it('should handle database errors during findById', async () => {
      const todoId = 'todo-123';

      mockDb.get.mockRejectedValueOnce(new Error('Database connection error'));

      await expect(todosRepository.findById(todoId))
        .rejects.toThrow('Database connection error');
    });
  });

  describe('findByUserId', () => {
    it('should find all todos for a user', async () => {
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

      mockDb.all.mockResolvedValueOnce(mockTodos);

      const result = await todosRepository.findByUserId(userId);

      expect(result).toEqual(mockTodos);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it('should return empty array for user with no todos', async () => {
      const userId = 'user-with-no-todos';

      mockDb.all.mockResolvedValueOnce([]);

      const result = await todosRepository.findByUserId(userId);

      expect(result).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update todo successfully', async () => {
      const todoId = 'todo-123';
      const updateData = {
        title: 'Updated Todo',
        completed: true,
      };

      const updatedTodo = {
        id: todoId,
        title: 'Updated Todo',
        description: 'Original description',
        userId: 'user-123',
        completed: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.execute.mockResolvedValueOnce([updatedTodo]);

      const result = await todosRepository.update(todoId, updateData);

      expect(result).toMatchObject(updatedTodo);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining(updateData)
      );
      expect(mockDb.where).toHaveBeenCalled();
    });

    it('should handle update of non-existent todo', async () => {
      const todoId = 'non-existent';
      const updateData = { title: 'Updated' };

      mockDb.execute.mockResolvedValueOnce([]);

      const result = await todosRepository.update(todoId, updateData);

      expect(result).toBeNull();
    });

    it('should automatically update updatedAt timestamp', async () => {
      const todoId = 'todo-123';
      const updateData = { title: 'Updated Todo' };

      mockDb.execute.mockResolvedValueOnce([{ id: todoId, ...updateData }]);

      await todosRepository.update(todoId, updateData);

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          ...updateData,
          updatedAt: expect.any(Date),
        })
      );
    });
  });

  describe('delete', () => {
    it('should delete todo successfully', async () => {
      const todoId = 'todo-123';

      mockDb.execute.mockResolvedValueOnce({ changes: 1 });

      const result = await todosRepository.delete(todoId);

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it('should return false for non-existent todo deletion', async () => {
      const todoId = 'non-existent';

      mockDb.execute.mockResolvedValueOnce({ changes: 0 });

      const result = await todosRepository.delete(todoId);

      expect(result).toBe(false);
    });

    it('should handle database errors during deletion', async () => {
      const todoId = 'todo-123';

      mockDb.execute.mockRejectedValueOnce(new Error('Database constraint error'));

      await expect(todosRepository.delete(todoId))
        .rejects.toThrow('Database constraint error');
    });
  });

  describe('findAll', () => {
    it('should find all todos', async () => {
      const mockTodos = [
        { id: 'todo-1', title: 'Todo 1', userId: 'user-1' },
        { id: 'todo-2', title: 'Todo 2', userId: 'user-2' },
      ];

      mockDb.all.mockResolvedValueOnce(mockTodos);

      const result = await todosRepository.findAll();

      expect(result).toEqual(mockTodos);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle empty database', async () => {
      mockDb.all.mockResolvedValueOnce([]);

      const result = await todosRepository.findAll();

      expect(result).toEqual([]);
    });
  });
});