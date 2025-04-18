// Jest is automatically available in the global scope
import { searchService } from '../../src/services/searchService';
import { vectorizeService } from '../../src/services/vectorizeService';
import { embeddingService } from '../../src/services/embeddingService';
import { ServiceError } from '@dome/common';

// Mock dependencies
jest.mock('../../src/services/vectorizeService');
jest.mock('../../src/services/embeddingService');

// Mock note repository
jest.mock('../../src/repositories/noteRepository', () => {
  return {
    NoteRepository: jest.fn().mockImplementation(() => {
      return {
        findById: jest.fn(),
      };
    }),
  };
});

describe('SearchService', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {
      prepare: jest.fn().mockReturnThis(),
      bind: jest.fn().mockReturnThis(),
      first: jest.fn(),
    } as unknown as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    EMBED_QUEUE: {} as Queue<any>,
  };

  // Mock data
  const mockUserId = 'user-123';
  const mockQuery = 'test query';
  const mockEmbedding = new Array(1536).fill(0.1);
  const mockSearchResults = [
    {
      id: 'vector-1',
      score: 0.95,
      metadata: {
        userId: mockUserId,
        noteId: 'note-1',
        createdAt: 1617235678000,
      },
    },
    {
      id: 'vector-2',
      score: 0.85,
      metadata: {
        userId: mockUserId,
        noteId: 'note-2',
        createdAt: 1617235679000,
      },
    },
  ];
  const mockNotes = [
    {
      id: 'note-1',
      userId: mockUserId,
      title: 'Test Note 1',
      body: 'This is test note 1',
      contentType: 'text/plain',
      createdAt: 1617235678000,
      updatedAt: 1617235678000,
      embeddingStatus: 'completed',
    },
    {
      id: 'note-2',
      userId: mockUserId,
      title: 'Test Note 2',
      body: 'This is test note 2',
      contentType: 'text/plain',
      createdAt: 1617235679000,
      updatedAt: 1617235679000,
      embeddingStatus: 'completed',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock embeddingService.queryEmbeddings
    (embeddingService.queryEmbeddings as jest.Mock).mockResolvedValue(mockSearchResults);

    // Mock vectorizeService.queryVectors
    (vectorizeService.queryVectors as jest.Mock).mockResolvedValue(mockSearchResults);

    // Mock noteRepository.findById
    const mockNoteRepo = searchService['noteRepository'];
    mockNoteRepo.findById = jest.fn().mockImplementation((env, id) => {
      const note = mockNotes.find(n => n.id === id);
      if (note) return Promise.resolve(note);
      return Promise.resolve(null);
    });
  });

  describe('searchNotes', () => {
    it('should search notes using semantic search', async () => {
      // Arrange
      const options = {
        userId: mockUserId,
        query: mockQuery,
        limit: 10,
      };

      // Act
      const results = await searchService.searchNotes(mockEnv, options);

      // Assert
      expect(vectorizeService.queryVectors).toHaveBeenCalledWith(mockEnv, mockQuery, {
        topK: 10,
        filter: { userId: mockUserId },
      });
      expect(results.length).toBe(2);
      expect(results[0].id).toBe('note-1');
      expect(results[0].score).toBe(0.95);
      expect(results[1].id).toBe('note-2');
      expect(results[1].score).toBe(0.85);
    });

    it('should filter results by content type', async () => {
      // Arrange
      const options = {
        userId: mockUserId,
        query: mockQuery,
        contentType: 'text/plain',
        limit: 10,
      };

      // Act
      const results = await searchService.searchNotes(mockEnv, options);

      // Assert
      expect(results.length).toBe(2);
      expect(results[0].contentType).toBe('text/plain');
      expect(results[1].contentType).toBe('text/plain');
    });

    it('should filter results by date range', async () => {
      // Arrange
      const startDate = 1617235678000;
      const endDate = 1617235679000;
      const options = {
        userId: mockUserId,
        query: mockQuery,
        startDate,
        endDate,
        limit: 10,
      };

      // Act
      const results = await searchService.searchNotes(mockEnv, options);

      // Assert
      expect(vectorizeService.queryVectors).toHaveBeenCalledWith(mockEnv, mockEmbedding, {
        topK: 10,
        filter: {
          userId: mockUserId,
          createdAt: {
            $gte: startDate,
            $lte: endDate,
          },
        },
      });
      expect(results.length).toBe(2);
    });

    it('should throw ServiceError when vector search fails', async () => {
      // Arrange
      const options = {
        userId: mockUserId,
        query: mockQuery,
        limit: 10,
      };
      const error = new Error('Vector search error');
      (vectorizeService.queryVectors as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(searchService.searchNotes(mockEnv, options)).rejects.toThrow(ServiceError);
    });
  });

  describe('search', () => {
    it('should call searchNotes', async () => {
      // Arrange
      const options = {
        userId: mockUserId,
        query: mockQuery,
        limit: 10,
      };

      // Mock searchNotes
      jest.spyOn(searchService, 'searchNotes').mockResolvedValueOnce([
        {
          id: 'note-1',
          title: 'Test Note 1',
          body: 'This is test note 1',
          score: 0.95,
          createdAt: 1617235678000,
          updatedAt: 1617235678000,
          contentType: 'text/plain',
        },
      ]);

      // Act
      const results = await searchService.search(mockEnv, options);

      // Assert
      expect(searchService.searchNotes).toHaveBeenCalledWith(mockEnv, options);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('note-1');
      expect(results[0].score).toBe(0.95);
    });
  });
});
