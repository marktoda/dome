import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { noteService } from '../../src/services/noteService';
import { NoteRepository } from '../../src/repositories/noteRepository';
import { embeddingService } from '../../src/services/embeddingService';
import { Note, EmbeddingStatus } from '../../src/models/note';
import { NotFoundError } from '@dome/common';

// Mock dependencies
vi.mock('../../src/repositories/noteRepository', () => {
  return {
    NoteRepository: vi.fn().mockImplementation(() => {
      return {
        create: vi.fn(),
        findById: vi.fn(),
        findByUserId: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };
    }),
  };
});

vi.mock('../../src/services/embeddingService', () => ({
  embeddingService: {
    enqueueEmbedding: vi.fn(),
  },
}));

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid'),
}));

describe('NoteService', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    EMBED_QUEUE: {} as Queue<any>,
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Mock note
  const mockNote: Note = {
    id: 'note-123',
    userId: mockUserId,
    title: 'Test Note',
    body: 'This is a test note',
    contentType: 'text/plain',
    createdAt: 1617235678000,
    updatedAt: 1617235678000,
    embeddingStatus: EmbeddingStatus.COMPLETED,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('createNote', () => {
    it('should create a note successfully', async () => {
      // Arrange
      const mockNoteData = {
        userId: mockUserId,
        title: 'Test Note',
        body: 'This is a test note',
        contentType: 'text/plain',
      };

      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.create).mockResolvedValue(mockNote);

      // Act
      const result = await noteService.createNote(mockEnv, mockNoteData);

      // Assert
      expect(noteRepo.create).toHaveBeenCalledWith(mockEnv, mockNoteData);
      expect(result).toEqual(mockNote);
    });

    it('should start embedding process by default', async () => {
      // Arrange
      const mockNoteData = {
        userId: mockUserId,
        title: 'Test Note',
        body: 'This is a test note',
        contentType: 'text/plain',
      };

      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.create).mockResolvedValue(mockNote);
      
      // Spy on the private processEmbedding method
      const processEmbeddingSpy = vi.spyOn(noteService as any, 'processEmbedding').mockResolvedValue(undefined);

      // Act
      await noteService.createNote(mockEnv, mockNoteData);

      // Assert
      expect(processEmbeddingSpy).toHaveBeenCalledWith(
        mockEnv,
        mockNote.id,
        mockNote.body,
        mockNote.userId
      );
    });

    it('should not start embedding process when startEmbedding is false', async () => {
      // Arrange
      const mockNoteData = {
        userId: mockUserId,
        title: 'Test Note',
        body: 'This is a test note',
        contentType: 'text/plain',
      };

      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.create).mockResolvedValue(mockNote);
      
      // Spy on the private processEmbedding method
      const processEmbeddingSpy = vi.spyOn(noteService as any, 'processEmbedding').mockResolvedValue(undefined);

      // Act
      await noteService.createNote(mockEnv, mockNoteData, false);

      // Assert
      expect(processEmbeddingSpy).not.toHaveBeenCalled();
    });

    it('should handle errors during note creation', async () => {
      // Arrange
      const mockNoteData = {
        userId: mockUserId,
        title: 'Test Note',
        body: 'This is a test note',
        contentType: 'text/plain',
      };

      const error = new Error('Database error');
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.create).mockRejectedValue(error);

      // Act & Assert
      await expect(noteService.createNote(mockEnv, mockNoteData)).rejects.toThrow(error);
    });
  });

  describe('getNoteById', () => {
    it('should get a note by ID successfully', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(mockNote);

      // Act
      const result = await noteService.getNoteById(mockEnv, 'note-123', mockUserId);

      // Assert
      expect(noteRepo.findById).toHaveBeenCalledWith(mockEnv, 'note-123');
      expect(result).toEqual(mockNote);
    });

    it('should throw NotFoundError if note does not exist', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(null);

      // Act & Assert
      await expect(noteService.getNoteById(mockEnv, 'note-123', mockUserId)).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError if note belongs to a different user', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      const noteWithDifferentUser = {
        ...mockNote,
        userId: 'different-user',
      };
      vi.mocked(noteRepo.findById).mockResolvedValue(noteWithDifferentUser);

      // Act & Assert
      await expect(noteService.getNoteById(mockEnv, 'note-123', mockUserId)).rejects.toThrow(NotFoundError);
    });
  });

  describe('listNotes', () => {
    it('should list notes for a user successfully', async () => {
      // Arrange
      const mockNotes = [mockNote, { ...mockNote, id: 'note-456' }];
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findByUserId).mockResolvedValue(mockNotes);

      // Act
      const result = await noteService.listNotes(mockEnv, mockUserId);

      // Assert
      expect(noteRepo.findByUserId).toHaveBeenCalledWith(mockEnv, mockUserId);
      expect(result).toEqual({
        notes: mockNotes,
        count: 2,
        total: 2,
      });
    });

    it('should filter notes by content type if specified', async () => {
      // Arrange
      const mockNotes = [
        mockNote,
        { ...mockNote, id: 'note-456', contentType: 'text/markdown' },
      ];
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findByUserId).mockResolvedValue(mockNotes);

      // Act
      const result = await noteService.listNotes(mockEnv, mockUserId, {
        contentType: 'text/plain',
      });

      // Assert
      expect(result).toEqual({
        notes: [mockNote],
        count: 1,
        total: 1,
      });
    });

    it('should apply pagination correctly', async () => {
      // Arrange
      const mockNotes = Array.from({ length: 10 }, (_, i) => ({
        ...mockNote,
        id: `note-${i + 1}`,
      }));
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findByUserId).mockResolvedValue(mockNotes);

      // Act
      const result = await noteService.listNotes(mockEnv, mockUserId, {
        limit: 3,
        offset: 2,
      });

      // Assert
      expect(result).toEqual({
        notes: mockNotes.slice(2, 5),
        count: 3,
        total: 10,
      });
    });
  });

  describe('updateNote', () => {
    it('should update a note successfully', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(mockNote);
      
      const updateData = {
        title: 'Updated Title',
        body: 'Updated content',
      };
      
      const updatedNote = {
        ...mockNote,
        ...updateData,
        updatedAt: 1617235679000,
      };
      
      vi.mocked(noteRepo.update).mockResolvedValue(updatedNote);

      // Act
      const result = await noteService.updateNote(mockEnv, 'note-123', mockUserId, updateData);

      // Assert
      expect(noteRepo.findById).toHaveBeenCalledWith(mockEnv, 'note-123');
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, 'note-123', updateData);
      expect(result).toEqual(updatedNote);
    });

    it('should regenerate embedding when body is updated', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(mockNote);
      
      const updateData = {
        body: 'Updated content',
      };
      
      const updatedNote = {
        ...mockNote,
        ...updateData,
        updatedAt: 1617235679000,
      };
      
      vi.mocked(noteRepo.update).mockResolvedValue(updatedNote);
      
      // Spy on the private processEmbedding method
      const processEmbeddingSpy = vi.spyOn(noteService as any, 'processEmbedding').mockResolvedValue(undefined);

      // Act
      await noteService.updateNote(mockEnv, 'note-123', mockUserId, updateData);

      // Assert
      // First update call for the note content
      expect(noteRepo.update).toHaveBeenNthCalledWith(1, mockEnv, 'note-123', updateData);
      
      // Second update call for the embedding status
      expect(noteRepo.update).toHaveBeenNthCalledWith(2, mockEnv, 'note-123', {
        embeddingStatus: EmbeddingStatus.PENDING,
      });
      
      // Check if processEmbedding was called
      expect(processEmbeddingSpy).toHaveBeenCalledWith(
        mockEnv,
        'note-123',
        'Updated content',
        mockUserId
      );
    });

    it('should throw NotFoundError if note does not exist', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(null);
      
      const updateData = {
        title: 'Updated Title',
      };

      // Act & Assert
      await expect(noteService.updateNote(mockEnv, 'note-123', mockUserId, updateData)).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError if note belongs to a different user', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      const noteWithDifferentUser = {
        ...mockNote,
        userId: 'different-user',
      };
      vi.mocked(noteRepo.findById).mockResolvedValue(noteWithDifferentUser);
      
      const updateData = {
        title: 'Updated Title',
      };

      // Act & Assert
      await expect(noteService.updateNote(mockEnv, 'note-123', mockUserId, updateData)).rejects.toThrow(NotFoundError);
    });
  });

  describe('deleteNote', () => {
    it('should delete a note successfully', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(mockNote);
      vi.mocked(noteRepo.delete).mockResolvedValue(true);

      // Act
      const result = await noteService.deleteNote(mockEnv, 'note-123', mockUserId);

      // Assert
      expect(noteRepo.findById).toHaveBeenCalledWith(mockEnv, 'note-123');
      expect(noteRepo.delete).toHaveBeenCalledWith(mockEnv, 'note-123');
      expect(result).toEqual({
        success: true,
        message: 'Note deleted successfully',
      });
    });

    it('should throw NotFoundError if note does not exist', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.findById).mockResolvedValue(null);

      // Act & Assert
      await expect(noteService.deleteNote(mockEnv, 'note-123', mockUserId)).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError if note belongs to a different user', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      const noteWithDifferentUser = {
        ...mockNote,
        userId: 'different-user',
      };
      vi.mocked(noteRepo.findById).mockResolvedValue(noteWithDifferentUser);

      // Act & Assert
      await expect(noteService.deleteNote(mockEnv, 'note-123', mockUserId)).rejects.toThrow(NotFoundError);
    });
  });

  describe('generateTitle', () => {
    it('should use first line if it is short enough', () => {
      // Arrange
      const content = 'Short first line\nSecond line\nThird line';

      // Act
      const result = noteService.generateTitle(content);

      // Assert
      expect(result).toBe('Short first line');
    });

    it('should use first few words if first line is too long', () => {
      // Arrange
      const content = 'This is a very long first line that exceeds the 50 character limit for titles in the system';

      // Act
      const result = noteService.generateTitle(content);

      // Assert
      expect(result).toBe('This is a very long first...');
    });

    it('should truncate title if first few words are still too long', () => {
      // Arrange
      const content = 'ThisIsAnExtremelyLongWordThatWillExceedTheLimitEvenWithJustOneWord and more text';

      // Act
      const result = noteService.generateTitle(content);

      // Assert
      expect(result).toBe('ThisIsAnExtremelyLongWordThatWillExceedTheLimi...');
    });
  });

  describe('processEmbedding', () => {
    it('should process embedding successfully', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.update).mockResolvedValue(mockNote);
      vi.mocked(embeddingService.enqueueEmbedding).mockResolvedValue(undefined);

      // Act
      await (noteService as any).processEmbedding(
        mockEnv,
        'note-123',
        'This is a test note',
        mockUserId
      );

      // Assert
      // First update call to set status to PROCESSING
      expect(noteRepo.update).toHaveBeenNthCalledWith(1, mockEnv, 'note-123', {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });
      
      // Check if enqueueEmbedding was called
      expect(embeddingService.enqueueEmbedding).toHaveBeenCalledWith(
        mockEnv,
        mockUserId,
        'note-123',
        'This is a test note'
      );
      
      // Second update call to set status to COMPLETED
      expect(noteRepo.update).toHaveBeenNthCalledWith(2, mockEnv, 'note-123', {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    });

    it('should handle errors during embedding process', async () => {
      // Arrange
      const noteRepo = noteService['noteRepository'];
      vi.mocked(noteRepo.update).mockResolvedValue(mockNote);
      
      const error = new Error('Embedding error');
      vi.mocked(embeddingService.enqueueEmbedding).mockRejectedValue(error);

      // Act & Assert
      await expect((noteService as any).processEmbedding(
        mockEnv,
        'note-123',
        'This is a test note',
        mockUserId
      )).rejects.toThrow(error);
      
      // Check if status was updated to FAILED
      expect(noteRepo.update).toHaveBeenLastCalledWith(mockEnv, 'note-123', {
        embeddingStatus: EmbeddingStatus.FAILED,
      });
    });
  });
});