/**
 * Embedder Service Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder, DEFAULT_EMBEDDER_CONFIG, createEmbedder } from '../../src/services/embedder';

describe('Embedder', () => {
  let mockAI: Ai;
  
  beforeEach(() => {
    // Create a mock AI service
    mockAI = {
      run: vi.fn().mockResolvedValue({
        data: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6]
        ]
      })
    } as unknown as Ai;
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  describe('embed', () => {
    it('should call AI service with the correct model and texts', async () => {
      const embedder = new Embedder(mockAI);
      const texts = ['text1', 'text2'];
      
      await embedder.embed(texts);
      
      expect(mockAI.run).toHaveBeenCalledWith(
        DEFAULT_EMBEDDER_CONFIG.model,
        { text: texts }
      );
    });
    
    it('should return the embedding vectors from the AI service', async () => {
      const embedder = new Embedder(mockAI);
      const texts = ['text1', 'text2'];
      
      const result = await embedder.embed(texts);
      
      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6]
      ]);
    });
    
    it('should handle empty input', async () => {
      const embedder = new Embedder(mockAI);
      const result = await embedder.embed([]);
      
      expect(result).toEqual([]);
      expect(mockAI.run).not.toHaveBeenCalled();
    });
    
    it('should split large batches into smaller ones', async () => {
      const embedder = new Embedder(mockAI, {
        maxBatchSize: 2
      });
      
      // Create a batch of 5 texts
      const texts = ['text1', 'text2', 'text3', 'text4', 'text5'];
      
      // Mock the AI service to return different embeddings for each batch
      (mockAI.run as any).mockImplementation((model: string, options: { text: string[] }) => {
        if (options.text.includes('text1')) {
          return Promise.resolve({
            data: [
              [0.1, 0.2, 0.3],
              [0.4, 0.5, 0.6]
            ]
          });
        } else if (options.text.includes('text3')) {
          return Promise.resolve({
            data: [
              [0.7, 0.8, 0.9],
              [1.0, 1.1, 1.2]
            ]
          });
        } else {
          return Promise.resolve({
            data: [
              [1.3, 1.4, 1.5]
            ]
          });
        }
      });
      
      const result = await embedder.embed(texts);
      
      // Should have called the AI service 3 times (for batches of 2, 2, and 1)
      expect(mockAI.run).toHaveBeenCalledTimes(3);
      
      // Should have combined the results from all batches
      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
        [0.7, 0.8, 0.9],
        [1.0, 1.1, 1.2],
        [1.3, 1.4, 1.5]
      ]);
    });
    
    it('should retry on failure', async () => {
      const embedder = new Embedder(mockAI, {
        retryAttempts: 3,
        retryDelay: 10
      });
      
      // Mock the AI service to fail on the first attempt but succeed on the second
      (mockAI.run as any)
        .mockRejectedValueOnce(new Error('Rate limit exceeded'))
        .mockResolvedValueOnce({
          data: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6]
          ]
        });
      
      const texts = ['text1', 'text2'];
      const result = await embedder.embed(texts);
      
      // Should have called the AI service twice (one failure, one success)
      expect(mockAI.run).toHaveBeenCalledTimes(2);
      
      // Should have returned the successful result
      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6]
      ]);
    });
    
    it('should throw an error after exhausting all retry attempts', async () => {
      const embedder = new Embedder(mockAI, {
        retryAttempts: 2,
        retryDelay: 10
      });
      
      // Mock the AI service to always fail
      (mockAI.run as any).mockRejectedValue(new Error('Rate limit exceeded'));
      
      const texts = ['text1', 'text2'];
      
      await expect(embedder.embed(texts)).rejects.toThrow('Rate limit exceeded');
      
      // Should have called the AI service twice (both failures)
      expect(mockAI.run).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('createEmbedder', () => {
    it('should create an embedder with default config when no config is provided', () => {
      const embedder = createEmbedder(mockAI);
      expect(embedder).toBeInstanceOf(Embedder);
    });
    
    it('should create an embedder with custom config when provided', () => {
      const customConfig = {
        model: 'custom-model',
        maxBatchSize: 5
      };
      
      const embedder = createEmbedder(mockAI, customConfig);
      
      // We can't directly access private properties, so we'll test indirectly
      // by checking that the custom model is used
      embedder.embed(['test']);
      
      expect(mockAI.run).toHaveBeenCalledWith(
        'custom-model',
        { text: ['test'] }
      );
    });
  });
});