import { ReminderRepository } from '../../src/repositories/reminderRepository';
import {
  Reminder,
  CreateReminderData,
  UpdateReminderData,
  DeliveryMethod,
} from '../../src/models/reminder';
import { reminders } from '../../src/db/schema';
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

describe('ReminderRepository', () => {
  let repository: ReminderRepository;
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
      EMBED_QUEUE: {} as Queue<any>,
    };

    // Create repository
    repository = new ReminderRepository();
  });

  describe('create', () => {
    it('should create a new reminder', async () => {
      // Setup
      const now = Date.now();
      const createData: CreateReminderData = {
        taskId: 'task-123',
        remindAt: now + 3600000, // 1 hour from now
        deliveryMethod: DeliveryMethod.EMAIL,
      };

      const expectedReminder: Reminder = {
        id: 'mock-uuid',
        taskId: 'task-123',
        remindAt: now + 3600000,
        delivered: false,
        deliveryMethod: DeliveryMethod.EMAIL,
        createdAt: now,
      };

      mockDb.all.mockResolvedValue([expectedReminder]);

      // Execute
      const result = await repository.create(mockEnv, createData);

      // Verify
      expect(mockDb.insert).toHaveBeenCalledWith(reminders);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uuid',
          taskId: 'task-123',
          remindAt: now + 3600000,
          delivered: false,
          deliveryMethod: DeliveryMethod.EMAIL,
        }),
      );
      expect(result).toEqual(expectedReminder);
    });
  });

  describe('update', () => {
    it('should update an existing reminder', async () => {
      // Setup
      const updateData: UpdateReminderData = {
        remindAt: Date.now() + 7200000, // 2 hours from now
        deliveryMethod: DeliveryMethod.SLACK,
      };

      const expectedReminder: Reminder = {
        id: 'reminder-123',
        taskId: 'task-123',
        remindAt: updateData.remindAt!,
        delivered: false,
        deliveryMethod: DeliveryMethod.SLACK,
        createdAt: 1000,
      };

      mockDb.all.mockResolvedValue([expectedReminder]);

      // Execute
      const result = await repository.update(mockEnv, 'reminder-123', updateData);

      // Verify
      expect(mockDb.update).toHaveBeenCalledWith(reminders);
      expect(mockDb.set).toHaveBeenCalledWith(updateData);
      expect(result).toEqual(expectedReminder);
    });

    it('should throw an error if reminder not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute & Verify
      await expect(
        repository.update(mockEnv, 'non-existent', { remindAt: Date.now() }),
      ).rejects.toThrow('Reminder with ID non-existent not found');
    });
  });

  describe('markDelivered', () => {
    it('should mark a reminder as delivered', async () => {
      // Setup
      const expectedReminder: Reminder = {
        id: 'reminder-123',
        taskId: 'task-123',
        remindAt: 1000,
        delivered: true,
        deliveryMethod: DeliveryMethod.EMAIL,
        createdAt: 1000,
      };

      mockDb.all.mockResolvedValue([expectedReminder]);

      // Execute
      const result = await repository.markDelivered(mockEnv, 'reminder-123');

      // Verify
      expect(mockDb.update).toHaveBeenCalledWith(reminders);
      expect(mockDb.set).toHaveBeenCalledWith({ delivered: true });
      expect(result).toEqual(expectedReminder);
    });

    it('should throw an error if reminder not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute & Verify
      await expect(repository.markDelivered(mockEnv, 'non-existent')).rejects.toThrow(
        'Reminder with ID non-existent not found',
      );
    });
  });

  describe('findByTaskId', () => {
    it('should find reminders by task ID', async () => {
      // Setup
      const expectedReminders: Reminder[] = [
        {
          id: 'reminder-1',
          taskId: 'task-123',
          remindAt: 1000,
          delivered: false,
          deliveryMethod: DeliveryMethod.EMAIL,
          createdAt: 1000,
        },
        {
          id: 'reminder-2',
          taskId: 'task-123',
          remindAt: 2000,
          delivered: false,
          deliveryMethod: DeliveryMethod.SLACK,
          createdAt: 1500,
        },
      ];

      mockDb.all.mockResolvedValue(expectedReminders);

      // Execute
      const result = await repository.findByTaskId(mockEnv, 'task-123');

      // Verify
      expect(result).toEqual(expectedReminders);
    });
  });

  describe('findDueReminders', () => {
    it('should find due reminders', async () => {
      // Setup
      const now = Date.now();
      const expectedReminders: Reminder[] = [
        {
          id: 'reminder-1',
          taskId: 'task-123',
          remindAt: now - 1000, // 1 second ago
          delivered: false,
          deliveryMethod: DeliveryMethod.EMAIL,
          createdAt: 1000,
        },
        {
          id: 'reminder-2',
          taskId: 'task-456',
          remindAt: now - 2000, // 2 seconds ago
          delivered: false,
          deliveryMethod: DeliveryMethod.SLACK,
          createdAt: 1500,
        },
      ];

      mockDb.all.mockResolvedValue(expectedReminders);

      // Execute
      const result = await repository.findDueReminders(mockEnv, now);

      // Verify
      expect(result).toEqual(expectedReminders);
    });
  });

  describe('delete', () => {
    it('should delete a reminder', async () => {
      // Setup
      mockDb.all.mockResolvedValue([{ id: 'reminder-123' }]);

      // Execute
      const result = await repository.delete(mockEnv, 'reminder-123');

      // Verify
      expect(mockDb.delete).toHaveBeenCalledWith(reminders);
      expect(result).toBe(true);
    });

    it('should return false if reminder not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute
      const result = await repository.delete(mockEnv, 'non-existent');

      // Verify
      expect(result).toBe(false);
    });
  });
});
