import { describe, it, expect, vi, beforeEach } from 'vitest';
import { constellationService } from '../../src/services/constellationService';
import { ServiceError, EmbedJob } from '@dome/common';

describe('ConstellationService', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    EMBED_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue<any>,
    CONSTELLATION: {
      embed: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      stats: vi.fn().mockResolvedValue({ vectors: 100, dimension: 1536 }),
    },
  };

  // Test data
  const userId = 'user-123';
  const noteId = 'note-456';
  const text = 'This is a test note for embedding';
  const filter = { userId: 'user-123' };
  const topK = 5;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enqueueEmbedding', () => {
    it('should enqueue a job with preprocessed text', async () => {
      // Act
      await constellationService.enqueueEmbedding(mockEnv, userId, noteId, text);

      // Assert
      expect(mockEnv.EMBED_QUEUE.send).toHaveBeenCalledTimes(1);
      
      // Verify job structure
      const sendMock = mockEnv.EMBED_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
      const job = sendMock.mock.calls[0][0];
      expect(job).toMatchObject({
        userId,
        noteId,
        text: expect.any(String), // Preprocessed text
        created: expect.any(Number),
        version: 1,
      });
      
      // Verify text preprocessing
      expect(job.text).toBe(text.trim());
    });

    it('should handle very short text inputs', async () => {
      // Arrange
      const shortText = 'hi';
      
      // Act
      await constellationService.enqueueEmbedding(mockEnv, userId, noteId, shortText);
      
      // Assert
      const sendMock = mockEnv.EMBED_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
      const job = sendMock.mock.calls[0][0];
      
      // Should pad very short inputs
      expect(job.text).toBe('hi hi query search');
    });

    it('should truncate very long text inputs', async () => {
      // Arrange
      const longText = 'a'.repeat(10000);
      
      // Act
      await constellationService.enqueueEmbedding(mockEnv, userId, noteId, longText);
      
      // Assert
      const sendMock = mockEnv.EMBED_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
      const job = sendMock.mock.calls[0][0];
      
      // Should truncate to MAX_TEXT_LENGTH (8192)
      expect(job.text.length).toBe(8192);
    });

    it('should throw ServiceError when queue send fails', async () => {
      // Arrange
      mockEnv.EMBED_QUEUE.send = vi.fn().mockRejectedValueOnce(new Error('Queue error'));
      
      // Act & Assert
      await expect(constellationService.enqueueEmbedding(mockEnv, userId, noteId, text))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('embedDirectly', () => {
    it('should call Constellation embed with preprocessed text', async () => {
      // Act
      await constellationService.embedDirectly(mockEnv, userId, noteId, text);

      // Assert
      expect(mockEnv.CONSTELLATION.embed).toHaveBeenCalledTimes(1);
      
      // Verify job structure
      const embedMock = mockEnv.CONSTELLATION.embed as unknown as ReturnType<typeof vi.fn>;
      const job = embedMock.mock.calls[0][0];
      expect(job).toMatchObject({
        userId,
        noteId,
        text: expect.any(String),
        created: expect.any(Number),
        version: 1,
      });
    });

    it('should throw ServiceError when Constellation binding is missing', async () => {
      // Arrange
      const envWithoutConstellation = { ...mockEnv, CONSTELLATION: undefined };
      
      // Act & Assert
      await expect(constellationService.embedDirectly(envWithoutConstellation, userId, noteId, text))
        .rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError when Constellation embed fails', async () => {
      // Arrange
      mockEnv.CONSTELLATION.embed = vi.fn().mockRejectedValueOnce(new Error('Embedding error'));
      
      // Act & Assert
      await expect(constellationService.embedDirectly(mockEnv, userId, noteId, text))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('query', () => {
    it('should call Constellation query with preprocessed text', async () => {
      // Act
      await constellationService.query(mockEnv, text, filter, topK);

      // Assert
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledTimes(1);
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledWith(
        text.trim(), // Preprocessed text
        filter,
        topK
      );
    });

    it('should use default topK when not provided', async () => {
      // Act
      await constellationService.query(mockEnv, text, filter);

      // Assert
      expect(mockEnv.CONSTELLATION.query).toHaveBeenCalledWith(
        text.trim(),
        filter,
        10 // Default topK
      );
    });

    it('should throw ServiceError when Constellation binding is missing', async () => {
      // Arrange
      const envWithoutConstellation = { ...mockEnv, CONSTELLATION: undefined };
      
      // Act & Assert
      await expect(constellationService.query(envWithoutConstellation, text, filter))
        .rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError when Constellation query fails', async () => {
      // Arrange
      mockEnv.CONSTELLATION.query = vi.fn().mockRejectedValueOnce(new Error('Query error'));
      
      // Act & Assert
      await expect(constellationService.query(mockEnv, text, filter))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('getStats', () => {
    it('should call Constellation stats', async () => {
      // Act
      const result = await constellationService.getStats(mockEnv);

      // Assert
      expect(mockEnv.CONSTELLATION.stats).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ vectors: 100, dimension: 1536 });
    });

    it('should throw ServiceError when Constellation binding is missing', async () => {
      // Arrange
      const envWithoutConstellation = { ...mockEnv, CONSTELLATION: undefined };
      
      // Act & Assert
      await expect(constellationService.getStats(envWithoutConstellation))
        .rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError when Constellation stats fails', async () => {
      // Arrange
      mockEnv.CONSTELLATION.stats = vi.fn().mockRejectedValueOnce(new Error('Stats error'));
      
      // Act & Assert
      await expect(constellationService.getStats(mockEnv))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('preprocess', () => {
    it('should normalize whitespace', () => {
      // Arrange
      const textWithExtraSpaces = '  This   has   extra   spaces  ';
      
      // Act
      const result = constellationService['preprocess'](textWithExtraSpaces);
      
      // Assert
      expect(result).toBe('This has extra spaces');
    });

    it('should handle very short inputs by padding', () => {
      // Arrange
      const shortText = 'hi';
      
      // Act
      const result = constellationService['preprocess'](shortText);
      
      // Assert
      expect(result).toBe('hi hi query search');
    });

    it('should truncate very long inputs', () => {
      // Arrange
      const longText = 'a'.repeat(10000);
      
      // Act
      const result = constellationService['preprocess'](longText);
      
      // Assert
      expect(result.length).toBe(8192);
    });
  });
});