import { NoteRepository } from '../../src/repositories/noteRepository';
import { Note, CreateNoteData, UpdateNoteData, EmbeddingStatus } from '../../src/models/note';
import { notes } from '../../src/db/schema';
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

describe('NoteRepository', () => {
  let repository: NoteRepository;
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
    repository = new NoteRepository();
  });

  describe('create', () => {
    it('should create a new note', async () => {
      // Setup
      const createData: CreateNoteData = {
        userId: 'user-123',
        title: 'Test Note',
        body: 'This is a test note',
        contentType: 'text/plain',
      };

      const expectedNote: Note = {
        id: 'mock-uuid',
        userId: 'user-123',
        title: 'Test Note',
        body: 'This is a test note',
        contentType: 'text/plain',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        embeddingStatus: EmbeddingStatus.PENDING,
      };

      mockDb.all.mockResolvedValue([expectedNote]);

      // Execute
      const result = await repository.create(mockEnv, createData);

      // Verify
      expect(mockDb.insert).toHaveBeenCalledWith(notes);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uuid',
          userId: 'user-123',
          title: 'Test Note',
          body: 'This is a test note',
          contentType: 'text/plain',
          embeddingStatus: 'pending',
        }),
      );
      expect(result).toEqual(expectedNote);
    });
  });

  describe('update', () => {
    it('should update an existing note', async () => {
      // Setup
      const updateData: UpdateNoteData = {
        title: 'Updated Title',
        body: 'Updated body',
      };

      const expectedNote: Note = {
        id: 'note-123',
        userId: 'user-123',
        title: 'Updated Title',
        body: 'Updated body',
        contentType: 'text/plain',
        createdAt: 1000,
        updatedAt: Date.now(),
        embeddingStatus: EmbeddingStatus.PENDING,
      };

      mockDb.all.mockResolvedValue([expectedNote]);

      // Execute
      const result = await repository.update(mockEnv, 'note-123', updateData);

      // Verify
      expect(mockDb.update).toHaveBeenCalledWith(notes);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Updated Title',
          body: 'Updated body',
          updatedAt: expect.any(Number),
        }),
      );
      expect(result).toEqual(expectedNote);
    });

    it('should throw an error if note not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute & Verify
      await expect(
        repository.update(mockEnv, 'non-existent', { title: 'New Title' }),
      ).rejects.toThrow('Note with ID non-existent not found');
    });
  });

  describe('findByUserId', () => {
    it('should find notes by user ID', async () => {
      // Setup
      const expectedNotes: Note[] = [
        {
          id: 'note-1',
          userId: 'user-123',
          title: 'Note 1',
          body: 'Body 1',
          contentType: 'text/plain',
          createdAt: 1000,
          updatedAt: 1000,
          embeddingStatus: EmbeddingStatus.COMPLETED,
        },
        {
          id: 'note-2',
          userId: 'user-123',
          title: 'Note 2',
          body: 'Body 2',
          contentType: 'text/plain',
          createdAt: 2000,
          updatedAt: 2000,
          embeddingStatus: EmbeddingStatus.COMPLETED,
        },
      ];

      mockDb.all.mockResolvedValue(expectedNotes);

      // Execute
      const result = await repository.findByUserId(mockEnv, 'user-123');

      // Verify
      expect(result).toEqual(expectedNotes);
    });
  });

  describe('delete', () => {
    it('should delete a note', async () => {
      // Setup
      mockDb.all.mockResolvedValue([{ id: 'note-123' }]);

      // Execute
      const result = await repository.delete(mockEnv, 'note-123');

      // Verify
      expect(mockDb.delete).toHaveBeenCalledWith(notes);
      expect(result).toBe(true);
    });

    it('should return false if note not found', async () => {
      // Setup
      mockDb.all.mockResolvedValue([]);

      // Execute
      const result = await repository.delete(mockEnv, 'non-existent');

      // Verify
      expect(result).toBe(false);
    });
  });
});
