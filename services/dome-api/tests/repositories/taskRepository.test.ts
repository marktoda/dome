import { TaskRepository } from '../../src/repositories/taskRepository';
import {
  Task,
  CreateTaskData,
  UpdateTaskData,
  TaskStatus,
  TaskPriority,
} from '../../src/models/task';
import { tasks } from '../../src/db/schema';
import { getDb } from '../../src/db';
import { Bindings } from '../../src/types';

// Mock the uuid module
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
}));

// Mock the database
jest.mock('../../src/db', () => ({
  getDb: jest.fn(),
  handleDatabaseError: jest.fn(error => error),
}));

describe('TaskRepository', () => {
  let repository: TaskRepository;
  let mockEnv: Bindings;
  let mockDb: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock DB
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      all: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    // Mock getDb to return our mock
    (getDb as jest.Mock).mockReturnValue(mockDb);

    // Create mock environment
    mockEnv = {
      D1_DATABASE: {} as D1Database,
      VECTORIZE: {} as VectorizeIndex,
      RAW: {} as R2Bucket,
      EVENTS: {} as Queue<any>,
    };

    // Create repository
    repository = new TaskRepository();
  });

  describe('create', () => {
    it('should create a new task', async () => {
      // Setup
      const createData: CreateTaskData = {
        userId: 'user-123',
        title: 'Test Task',
        description: 'This is a test task',
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dueDate: Date.now() + 86400000, // Tomorrow
      };

      const expectedTask: Task = {
        id: 'mock-uuid',
        userId: 'user-123',
        title: 'Test Task',
        description: 'This is a test task',
        status: TaskStatus.PENDING,
        priority: TaskPriority.MEDIUM,
        dueDate: createData.dueDate,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: undefined,
      };

      mockDb.all.mockResolvedValue([expectedTask]);

      // Execute
      const result = await repository.create(mockEnv, createData);

      // Verify
      expect(mockDb.insert).toHaveBeenCalledWith(tasks);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uuid',
          userId: 'user-123',
          title: 'Test Task',
          description: 'This is a test task',
          status: TaskStatus.PENDING,
          priority: TaskPriority.MEDIUM,
          dueDate: createData.dueDate,
        }),
      );
      expect(result).toEqual(expectedTask);
    });
  });

  describe('update', () => {
    it('should update an existing task', async () => {
      // Setup
      const updateData: UpdateTaskData = {
        title: 'Updated Task',
        description: 'Updated description',
        status: TaskStatus.IN_PROGRESS,
      };

      const expectedTask: Task = {
        id: 'task-123',
        userId: 'user-123',
        title: 'Updated Task',
        description: 'Updated description',
        status: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.MEDIUM,
        createdAt: 1000,
        updatedAt: Date.now(),
        completedAt: undefined,
      };

      mockDb.all.mockResolvedValue([expectedTask]);

      // Execute
      const result = await repository.update(mockEnv, 'task-123', updateData);

      // Verify
      expect(mockDb.update).toHaveBeenCalledWith(tasks);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Updated Task',
          description: 'Updated description',
          status: TaskStatus.IN_PROGRESS,
          updatedAt: expect.any(Number),
        }),
      );
      expect(result).toEqual(expectedTask);
    });

    it('should throw an error if task not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute & Verify
      await expect(
        repository.update(mockEnv, 'non-existent', { title: 'New Title' }),
      ).rejects.toThrow('Task with ID non-existent not found');
    });
  });

  describe('completeTask', () => {
    it('should mark a task as completed', async () => {
      // Setup
      const expectedTask: Task = {
        id: 'task-123',
        userId: 'user-123',
        title: 'Test Task',
        description: 'This is a test task',
        status: TaskStatus.COMPLETED,
        priority: TaskPriority.MEDIUM,
        createdAt: 1000,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      };

      mockDb.all.mockResolvedValue([expectedTask]);

      // Execute
      const result = await repository.completeTask(mockEnv, 'task-123');

      // Verify
      expect(mockDb.update).toHaveBeenCalledWith(tasks);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TaskStatus.COMPLETED,
          completedAt: expect.any(Number),
          updatedAt: expect.any(Number),
        }),
      );
      expect(result).toEqual(expectedTask);
    });

    it('should throw an error if task not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute & Verify
      await expect(repository.completeTask(mockEnv, 'non-existent')).rejects.toThrow(
        'Task with ID non-existent not found',
      );
    });
  });

  describe('findByUserId', () => {
    it('should find tasks by user ID', async () => {
      // Setup
      const expectedTasks: Task[] = [
        {
          id: 'task-1',
          userId: 'user-123',
          title: 'Task 1',
          description: 'Description 1',
          status: TaskStatus.PENDING,
          priority: TaskPriority.HIGH,
          createdAt: 1000,
          updatedAt: 1000,
          completedAt: undefined,
        },
        {
          id: 'task-2',
          userId: 'user-123',
          title: 'Task 2',
          description: 'Description 2',
          status: TaskStatus.IN_PROGRESS,
          priority: TaskPriority.MEDIUM,
          createdAt: 2000,
          updatedAt: 2000,
          completedAt: undefined,
        },
      ];

      mockDb.all.mockResolvedValue(expectedTasks);

      // Execute
      const result = await repository.findByUserId(mockEnv, 'user-123');

      // Verify
      expect(result).toEqual(expectedTasks);
    });
  });

  describe('findByUserIdAndStatus', () => {
    it('should find tasks by user ID and status', async () => {
      // Setup
      const expectedTasks: Task[] = [
        {
          id: 'task-1',
          userId: 'user-123',
          title: 'Task 1',
          description: 'Description 1',
          status: TaskStatus.PENDING,
          priority: TaskPriority.HIGH,
          createdAt: 1000,
          updatedAt: 1000,
          completedAt: undefined,
        },
      ];

      mockDb.all.mockResolvedValue(expectedTasks);

      // Execute
      const result = await repository.findByUserIdAndStatus(
        mockEnv,
        'user-123',
        TaskStatus.PENDING,
      );

      // Verify
      expect(result).toEqual(expectedTasks);
    });
  });

  describe('delete', () => {
    it('should delete a task', async () => {
      // Setup
      mockDb.all.mockResolvedValue([{ id: 'task-123' }]);

      // Execute
      const result = await repository.delete(mockEnv, 'task-123');

      // Verify
      expect(mockDb.delete).toHaveBeenCalledWith(tasks);
      expect(result).toBe(true);
    });

    it('should return false if task not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute
      const result = await repository.delete(mockEnv, 'non-existent');

      // Verify
      expect(result).toBe(false);
    });
  });
});
