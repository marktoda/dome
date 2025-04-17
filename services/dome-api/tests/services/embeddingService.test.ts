// Jest is automatically available in the global scope
import { embeddingService } from '../../src/services/embeddingService';
import { ServiceError } from '@dome/common';

// Mock AI binding
const mockAI = {
  run: jest.fn()
};

// Mock Bindings
const mockEnv = {
  AI: mockAI,
  D1_DATABASE: {} as D1Database,
  VECTORIZE: {} as VectorizeIndex,
  RAW: {} as R2Bucket,
  EVENTS: {} as Queue<any>
};

describe('EmbeddingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('generateEmbedding', () => {
    it('should generate an embedding for text', async () => {
      // Arrange
      const text = 'This is a test text for embedding';
      const mockEmbedding = {
        data: new Array(1536).fill(0.1)
      };
      
      (mockAI.run as jest.Mock).mockResolvedValueOnce(mockEmbedding);

      // Act
      const result = await embeddingService.generateEmbedding(mockEnv, text);

      // Assert
      expect(mockAI.run).toHaveBeenCalledWith(
        '@cf/baai/bge-small-en-v1.5',
        { text: expect.any(String) }
      );
      expect(result).toEqual(mockEmbedding.data);
    });

    it('should preprocess text before generating embedding', async () => {
      // Arrange
      const text = '  This   is a test   text  with   extra   spaces  ';
      const expectedProcessedText = 'This is a test text with extra spaces';
      const mockEmbedding = {
        data: new Array(1536).fill(0.1)
      };
      
      (mockAI.run as jest.Mock).mockResolvedValueOnce(mockEmbedding);

      // Act
      await embeddingService.generateEmbedding(mockEnv, text);

      // Assert
      expect(mockAI.run).toHaveBeenCalledWith(
        '@cf/baai/bge-small-en-v1.5',
        { text: expectedProcessedText }
      );
    });

    it('should throw ServiceError when AI binding is not available', async () => {
      // Arrange
      const text = 'This is a test text for embedding';
      const envWithoutAI = { ...mockEnv, AI: undefined };

      // Act & Assert
      await expect(embeddingService.generateEmbedding(envWithoutAI, text))
        .rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError when embedding generation fails', async () => {
      // Arrange
      const text = 'This is a test text for embedding';
      const error = new Error('AI error');
      
      (mockAI.run as jest.Mock).mockRejectedValueOnce(error);

      // Act & Assert
      await expect(embeddingService.generateEmbedding(mockEnv, text))
        .rejects.toThrow(ServiceError);
    });

    it('should throw ServiceError when embedding has invalid format', async () => {
      // Arrange
      const text = 'This is a test text for embedding';
      const invalidEmbedding = {
        data: [0.1, 0.2, 0.3] // Too short
      };
      
      (mockAI.run as jest.Mock).mockResolvedValueOnce(invalidEmbedding);

      // Act & Assert
      await expect(embeddingService.generateEmbedding(mockEnv, text))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('generateEmbeddings', () => {
    it('should generate embeddings for multiple texts', async () => {
      // Arrange
      const texts = [
        'This is the first text',
        'This is the second text',
        'This is the third text'
      ];
      
      const mockEmbeddings = [
        new Array(1536).fill(0.1),
        new Array(1536).fill(0.2),
        new Array(1536).fill(0.3)
      ];
      
      // Mock the generateEmbedding method to return the mock embeddings
      jest.spyOn(embeddingService, 'generateEmbedding')
        .mockResolvedValueOnce(mockEmbeddings[0])
        .mockResolvedValueOnce(mockEmbeddings[1])
        .mockResolvedValueOnce(mockEmbeddings[2]);

      // Act
      const result = await embeddingService.generateEmbeddings(mockEnv, texts);

      // Assert
      expect(embeddingService.generateEmbedding).toHaveBeenCalledTimes(3);
      expect(result).toEqual(mockEmbeddings);
    });

    it('should process texts in batches', async () => {
      // Arrange
      const texts = new Array(25).fill('Test text');
      const mockEmbedding = new Array(1536).fill(0.1);
      
      // Mock the generateEmbedding method to always return the same embedding
      jest.spyOn(embeddingService, 'generateEmbedding')
        .mockResolvedValue(mockEmbedding);

      // Act
      await embeddingService.generateEmbeddings(mockEnv, texts);

      // Assert
      expect(embeddingService.generateEmbedding).toHaveBeenCalledTimes(25);
    });

    it('should throw ServiceError when embedding generation fails', async () => {
      // Arrange
      const texts = ['Text 1', 'Text 2', 'Text 3'];
      const error = new Error('AI error');
      
      // Mock the generateEmbedding method to throw an error
      jest.spyOn(embeddingService, 'generateEmbedding')
        .mockRejectedValueOnce(error);

      // Act & Assert
      await expect(embeddingService.generateEmbeddings(mockEnv, texts))
        .rejects.toThrow(ServiceError);
    });
  });

  describe('splitTextIntoChunks', () => {
    it('should split long text into chunks', () => {
      // Arrange
      const longText = 'A'.repeat(5000);
      const maxChunkLength = 2000;

      // Act
      const chunks = embeddingService.splitTextIntoChunks(longText, maxChunkLength);

      // Assert
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(maxChunkLength);
      });
    });

    it('should split text by paragraphs when possible', () => {
      // Arrange
      const text = 'Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.';
      const maxChunkLength = 15; // Small enough to force splitting

      // Act
      const chunks = embeddingService.splitTextIntoChunks(text, maxChunkLength);

      // Assert
      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe('Paragraph 1.');
      expect(chunks[1]).toBe('Paragraph 2.');
      expect(chunks[2]).toBe('Paragraph 3.');
    });

    it('should split paragraphs into sentences when necessary', () => {
      // Arrange
      const text = 'Sentence 1. Sentence 2. Sentence 3.';
      const maxChunkLength = 12; // Small enough to force splitting

      // Act
      const chunks = embeddingService.splitTextIntoChunks(text, maxChunkLength);

      // Assert
      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe('Sentence 1.');
      expect(chunks[1]).toBe('Sentence 2.');
      expect(chunks[2]).toBe('Sentence 3.');
    });
  });
});