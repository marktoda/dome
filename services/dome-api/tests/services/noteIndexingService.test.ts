// Jest is automatically available in the global scope
import { noteIndexingService } from '../../src/services/noteIndexingService';
import { vectorizeService } from '../../src/services/vectorizeService';
import { embeddingService } from '../../src/services/embeddingService';
import { NoteRepository } from '../../src/repositories/noteRepository';
import { EmbeddingStatus } from '../../src/models/note';
import { ServiceError } from '@dome/common';

// Mock dependencies
jest.mock('../../src/services/vectorizeService');
jest.mock('../../src/services/embeddingService');
jest.mock('../../src/repositories/noteRepository');

describe('NoteIndexingService', () => {
  // Mock environment and data
  let mockEnv: any;

  // Mock data for pending notes
  const mockPendingNotes = [
    {
      id: 'note-1',
      userId: 'user-123',
      title: 'Test Note 1',
      body: 'Test body 1',
      contentType: 'text/plain',
      createdAt: 1617235678000,
      updatedAt: 1617235678000,
      embeddingStatus: EmbeddingStatus.PENDING,
    },
    {
      id: 'note-2',
      userId: 'user-123',
      title: 'Test Note 2',
      body: 'Test body 2',
      contentType: 'text/plain',
      createdAt: 1617235679000,
      updatedAt: 1617235679000,
      embeddingStatus: EmbeddingStatus.PENDING,
    },
  ];

  // Mock data
  const mockNote = {
    id: 'note-123',
    userId: 'user-123',
    title: 'Test Note',
    body: 'This is a test note for indexing',
    contentType: 'text/plain',
    createdAt: 1617235678000,
    updatedAt: 1617235678000,
    embeddingStatus: EmbeddingStatus.PENDING,
  };

  const mockPages = [
    {
      id: 'page-1',
      noteId: 'note-123',
      pageNum: 1,
      content: 'This is page 1 of the test note',
      createdAt: 1617235678000,
    },
    {
      id: 'page-2',
      noteId: 'note-123',
      pageNum: 2,
      content: 'This is page 2 of the test note',
      createdAt: 1617235678000,
    },
  ];

  const mockEmbedding = new Array(1536).fill(0.1);

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock environment for each test
    const mockD1Result = {
      results: mockPendingNotes,
    };

    const mockPrepareStmt = {
      bind: jest.fn().mockReturnThis(),
      all: jest.fn().mockResolvedValue(mockD1Result),
    };

    const mockD1Database = {
      prepare: jest.fn().mockReturnValue(mockPrepareStmt),
    };

    mockEnv = {
      D1_DATABASE: mockD1Database as unknown as D1Database,
      VECTORIZE: {} as VectorizeIndex,
      RAW: {} as R2Bucket,
      EVENTS: {} as Queue<any>,
    };

    // Mock NoteRepository
    (NoteRepository as jest.Mock).mockImplementation(() => {
      return {
        update: jest.fn().mockResolvedValue(mockNote),
        findPagesByNoteId: jest.fn().mockResolvedValue(mockPages),
      };
    });

    // Mock embeddingService.generateEmbedding
    (embeddingService.generateEmbedding as jest.Mock).mockResolvedValue(mockEmbedding);

    // Mock embeddingService.generateEmbeddings
    (embeddingService.generateEmbeddings as jest.Mock).mockResolvedValue([
      mockEmbedding,
      mockEmbedding,
    ]);

    // Mock vectorizeService methods
    (vectorizeService.addVector as jest.Mock).mockResolvedValue(undefined);
    (vectorizeService.updateVector as jest.Mock).mockResolvedValue(undefined);
    (vectorizeService.deleteVector as jest.Mock).mockResolvedValue(undefined);
  });

  describe('indexNote', () => {
    it('should index a note in Vectorize', async () => {
      // Act
      await noteIndexingService.indexNote(mockEnv, mockNote);

      // Assert
      const noteRepo = noteIndexingService['noteRepository'];

      // Should update note status to processing
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Should generate embedding
      expect(embeddingService.generateEmbedding).toHaveBeenCalledWith(mockEnv, mockNote.body);

      // Should add vector to Vectorize
      expect(vectorizeService.addVector).toHaveBeenCalledWith(mockEnv, mockNote.id, mockEmbedding, {
        userId: mockNote.userId,
        noteId: mockNote.id,
        createdAt: mockNote.createdAt,
      });

      // Should update note status to completed
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    });

    it('should update note status to failed when embedding generation fails', async () => {
      // Arrange
      const error = new Error('Embedding error');
      (embeddingService.generateEmbedding as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(noteIndexingService.indexNote(mockEnv, mockNote)).rejects.toThrow(ServiceError);

      const noteRepo = noteIndexingService['noteRepository'];

      // Should update note status to failed
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.FAILED,
      });
    });
  });

  describe('indexNotePages', () => {
    it('should index note pages in Vectorize', async () => {
      // Act
      await noteIndexingService.indexNotePages(mockEnv, mockNote, mockPages);

      // Assert
      const noteRepo = noteIndexingService['noteRepository'];

      // Should update note status to processing
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Should generate embeddings for pages
      expect(embeddingService.generateEmbeddings).toHaveBeenCalledWith(
        mockEnv,
        mockPages.map(page => page.content),
      );

      // Should add vectors to Vectorize for each page
      expect(vectorizeService.addVector).toHaveBeenCalledTimes(2);
      expect(vectorizeService.addVector).toHaveBeenCalledWith(
        mockEnv,
        mockPages[0].id,
        mockEmbedding,
        {
          userId: mockNote.userId,
          noteId: mockNote.id,
          createdAt: mockNote.createdAt,
          pageNum: mockPages[0].pageNum,
        },
      );
      expect(vectorizeService.addVector).toHaveBeenCalledWith(
        mockEnv,
        mockPages[1].id,
        mockEmbedding,
        {
          userId: mockNote.userId,
          noteId: mockNote.id,
          createdAt: mockNote.createdAt,
          pageNum: mockPages[1].pageNum,
        },
      );

      // Should update note status to completed
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    });

    it('should update note status to failed when embedding generation fails', async () => {
      // Arrange
      const error = new Error('Embedding error');
      (embeddingService.generateEmbeddings as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(
        noteIndexingService.indexNotePages(mockEnv, mockNote, mockPages),
      ).rejects.toThrow(ServiceError);

      const noteRepo = noteIndexingService['noteRepository'];

      // Should update note status to failed
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.FAILED,
      });
    });
  });

  describe('updateNoteIndex', () => {
    it('should update a note index in Vectorize', async () => {
      // Act
      await noteIndexingService.updateNoteIndex(mockEnv, mockNote);

      // Assert
      const noteRepo = noteIndexingService['noteRepository'];

      // Should update note status to processing
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.PROCESSING,
      });

      // Should generate embedding
      expect(embeddingService.generateEmbedding).toHaveBeenCalledWith(mockEnv, mockNote.body);

      // Should update vector in Vectorize
      expect(vectorizeService.updateVector).toHaveBeenCalledWith(
        mockEnv,
        mockNote.id,
        mockEmbedding,
        {
          userId: mockNote.userId,
          noteId: mockNote.id,
          createdAt: mockNote.createdAt,
        },
      );

      // Should update note status to completed
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNote.id, {
        embeddingStatus: EmbeddingStatus.COMPLETED,
      });
    });
  });

  describe('deleteNoteIndex', () => {
    it('should delete a note index from Vectorize', async () => {
      // Act
      await noteIndexingService.deleteNoteIndex(mockEnv, mockNote.id);

      // Assert
      // Should get note pages
      const noteRepo = noteIndexingService['noteRepository'];
      expect(noteRepo.findPagesByNoteId).toHaveBeenCalledWith(mockEnv, mockNote.id);

      // Should delete note vector
      expect(vectorizeService.deleteVector).toHaveBeenCalledWith(mockEnv, mockNote.id);

      // Should delete page vectors
      expect(vectorizeService.deleteVector).toHaveBeenCalledWith(mockEnv, mockPages[0].id);
      expect(vectorizeService.deleteVector).toHaveBeenCalledWith(mockEnv, mockPages[1].id);
    });
  });

  describe('processPendingNotes', () => {
    it('should process pending notes', async () => {
      // Arrange - mockPendingNotes is already set up in beforeEach

      // Mock indexNote and indexNotePages
      jest.spyOn(noteIndexingService, 'indexNote').mockResolvedValue();
      jest.spyOn(noteIndexingService, 'indexNotePages').mockResolvedValue();

      // Act
      const count = await noteIndexingService.processPendingNotes(mockEnv, 10);

      // Assert
      expect(mockEnv.D1_DATABASE.prepare).toHaveBeenCalled();
      expect(mockEnv.D1_DATABASE.prepare().bind).toHaveBeenCalledWith(EmbeddingStatus.PENDING, 10);

      // Should process each note
      expect(count).toBe(2);
      expect(noteIndexingService.indexNote).toHaveBeenCalledTimes(2);
    });

    it('should process notes with pages using indexNotePages', async () => {
      // Arrange - use only the first pending note
      mockEnv.D1_DATABASE.prepare().all = jest.fn().mockResolvedValueOnce({
        results: [mockPendingNotes[0]],
      });

      // Mock indexNote and indexNotePages
      jest.spyOn(noteIndexingService, 'indexNote').mockResolvedValue();
      jest.spyOn(noteIndexingService, 'indexNotePages').mockResolvedValue();

      // Mock findPagesByNoteId to return pages
      const noteRepo = noteIndexingService['noteRepository'];
      (noteRepo.findPagesByNoteId as jest.Mock).mockResolvedValueOnce(mockPages);

      // Act
      await noteIndexingService.processPendingNotes(mockEnv, 10);

      // Assert
      expect(noteRepo.findPagesByNoteId).toHaveBeenCalledWith(mockEnv, 'note-1');
      expect(noteIndexingService.indexNotePages).toHaveBeenCalledWith(
        mockEnv,
        mockPendingNotes[0],
        mockPages,
      );
      expect(noteIndexingService.indexNote).not.toHaveBeenCalled();
    });
  });
});
