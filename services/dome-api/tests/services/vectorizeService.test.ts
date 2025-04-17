// Jest is automatically available in the global scope
import { vectorizeService } from '../../src/services/vectorizeService';
import { ServiceError } from '@dome/common';

// Mock Bindings
const mockVectorizeIndex = {
  insert: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  query: jest.fn()
};

const mockEnv = {
  VECTORIZE: mockVectorizeIndex,
  D1_DATABASE: {} as D1Database,
  RAW: {} as R2Bucket,
  EVENTS: {} as Queue<any>
};

describe('VectorizeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('addVector', () => {
    it('should add a vector to Vectorize', async () => {
      // Arrange
      const id = 'test-id';
      const vector = new Array(1536).fill(0.1);
      const metadata = {
        userId: 'user-1',
        noteId: 'note-1',
        createdAt: Date.now()
      };

      (mockVectorizeIndex.insert as jest.Mock).mockResolvedValueOnce(undefined);

      // Act
      await vectorizeService.addVector(mockEnv, id, vector, metadata);

      // Assert
      expect(mockVectorizeIndex.insert).toHaveBeenCalledWith([
        {
          id,
          values: vector,
          metadata
        }
      ]);
    });

    it('should throw ServiceError when Vectorize insert fails', async () => {
      // Arrange
      const id = 'test-id';
      const vector = new Array(1536).fill(0.1);
      const metadata = {
        userId: 'user-1',
        noteId: 'note-1',
        createdAt: Date.now()
      };

      const error = new Error('Vectorize error');
      (mockVectorizeIndex.insert as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(vectorizeService.addVector(mockEnv, id, vector, metadata))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('updateVector', () => {
    it('should update a vector in Vectorize', async () => {
      // Arrange
      const id = 'test-id';
      const vector = new Array(1536).fill(0.1);
      const metadata = {
        userId: 'user-1',
        noteId: 'note-1',
        createdAt: Date.now()
      };

      (mockVectorizeIndex.upsert as jest.Mock).mockResolvedValueOnce(undefined);

      // Act
      await vectorizeService.updateVector(mockEnv, id, vector, metadata);

      // Assert
      expect(mockVectorizeIndex.upsert).toHaveBeenCalledWith([
        {
          id,
          values: vector,
          metadata
        }
      ]);
    });

    it('should throw ServiceError when Vectorize upsert fails', async () => {
      // Arrange
      const id = 'test-id';
      const vector = new Array(1536).fill(0.1);
      const metadata = {
        userId: 'user-1',
        noteId: 'note-1',
        createdAt: Date.now()
      };

      const error = new Error('Vectorize error');
      (mockVectorizeIndex.upsert as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(vectorizeService.updateVector(mockEnv, id, vector, metadata))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('deleteVector', () => {
    it('should delete a vector from Vectorize', async () => {
      // Arrange
      const id = 'test-id';
      (mockVectorizeIndex.delete as jest.Mock).mockResolvedValueOnce(undefined);

      // Act
      await vectorizeService.deleteVector(mockEnv, id);

      // Assert
      expect(mockVectorizeIndex.delete).toHaveBeenCalledWith([id]);
    });

    it('should throw ServiceError when Vectorize delete fails', async () => {
      // Arrange
      const id = 'test-id';
      const error = new Error('Vectorize error');
      (mockVectorizeIndex.delete as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(vectorizeService.deleteVector(mockEnv, id))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('queryVectors', () => {
    it('should query vectors from Vectorize', async () => {
      // Arrange
      const vector = new Array(1536).fill(0.1);
      const filter = { userId: 'user-1' };
      const topK = 5;

      const mockResults = {
        matches: [
          {
            id: 'vector-1',
            score: 0.95,
            metadata: { userId: 'user-1', noteId: 'note-1', createdAt: 123456789 }
          },
          {
            id: 'vector-2',
            score: 0.85,
            metadata: { userId: 'user-1', noteId: 'note-2', createdAt: 123456790 }
          }
        ]
      };

      (mockVectorizeIndex.query as jest.Mock).mockResolvedValueOnce(mockResults);

      // Act
      const results = await vectorizeService.queryVectors(mockEnv, vector, { topK, filter });

      // Assert
      expect(mockVectorizeIndex.query).toHaveBeenCalledWith({
        vector,
        topK,
        filter
      });
      expect(results).toEqual([
        {
          id: 'vector-1',
          score: 0.95,
          metadata: { userId: 'user-1', noteId: 'note-1', createdAt: 123456789 }
        },
        {
          id: 'vector-2',
          score: 0.85,
          metadata: { userId: 'user-1', noteId: 'note-2', createdAt: 123456790 }
        }
      ]);
    });

    it('should throw ServiceError when Vectorize query fails', async () => {
      // Arrange
      const vector = new Array(1536).fill(0.1);
      const error = new Error('Vectorize error');
      (mockVectorizeIndex.query as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(vectorizeService.queryVectors(mockEnv, vector))
        .rejects.toThrow(ServiceError);
    });
  });
});