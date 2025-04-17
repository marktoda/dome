import { Bindings } from '../types';
import { ServiceError } from '@dome/common';

/**
 * Service for generating embeddings using Workers AI
 */
export class EmbeddingService {
  // The embedding model to use
  private readonly embeddingModel = '@cf/baai/bge-small-en-v1.5';
  
  // The embedding dimension
  private readonly embeddingDimension = 1536;
  
  // Maximum batch size for embedding generation
  private readonly maxBatchSize = 20;
  
  /**
   * Generate an embedding for a single text
   * @param env Environment bindings
   * @param text Text to embed
   * @returns Promise<number[]> The embedding vector
   */
  async generateEmbedding(env: Bindings, text: string): Promise<number[]> {
    try {
      // Preprocess the text
      const processedText = this.preprocessText(text);
      
      // Check if AI binding is available
      if (!env.AI) {
        throw new Error('Workers AI binding is not available');
      }
      
      // Generate embedding using Workers AI
      const embedding = await env.AI.run(this.embeddingModel, { text: processedText });
      
      // Validate the embedding
      if (!embedding || !Array.isArray(embedding.data) || embedding.data.length !== this.embeddingDimension) {
        throw new Error(`Invalid embedding: expected array of length ${this.embeddingDimension}`);
      }
      
      return embedding.data;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw new ServiceError('Failed to generate embedding', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { textLength: text.length }
      });
    }
  }
  
  /**
   * Generate embeddings for multiple texts in batches
   * @param env Environment bindings
   * @param texts Array of texts to embed
   * @returns Promise<number[][]> Array of embedding vectors
   */
  async generateEmbeddings(env: Bindings, texts: string[]): Promise<number[][]> {
    try {
      const embeddings: number[][] = [];
      
      // Process in batches to avoid overloading the API
      for (let i = 0; i < texts.length; i += this.maxBatchSize) {
        const batch = texts.slice(i, i + this.maxBatchSize);
        
        // Process each text in the batch
        const batchPromises = batch.map(text => this.generateEmbedding(env, text));
        const batchEmbeddings = await Promise.all(batchPromises);
        
        embeddings.push(...batchEmbeddings);
      }
      
      return embeddings;
    } catch (error) {
      console.error('Error generating embeddings in batch:', error);
      throw new ServiceError('Failed to generate embeddings in batch', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { textsCount: texts.length }
      });
    }
  }
  
  /**
   * Preprocess text before embedding
   * @param text Text to preprocess
   * @returns Preprocessed text
   */
  preprocessText(text: string): string {
    // Remove excessive whitespace
    let processed = text.trim().replace(/\s+/g, ' ');
    
    // Truncate if too long (most embedding models have token limits)
    // This is a simple character-based truncation, a more sophisticated
    // approach would use a tokenizer to count tokens
    const maxChars = 8192;
    if (processed.length > maxChars) {
      processed = processed.substring(0, maxChars);
    }
    
    return processed;
  }
  
  /**
   * Split long text into chunks for embedding
   * @param text Long text to split
   * @param maxChunkLength Maximum chunk length
   * @returns Array of text chunks
   */
  splitTextIntoChunks(text: string, maxChunkLength = 2048): string[] {
    const chunks: string[] = [];
    
    // Simple splitting by paragraphs first
    const paragraphs = text.split(/\n\s*\n/);
    
    let currentChunk = '';
    
    for (const paragraph of paragraphs) {
      // If adding this paragraph would exceed the max length, save the current chunk and start a new one
      if (currentChunk.length + paragraph.length > maxChunkLength && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If the paragraph itself is too long, split it into sentences
      if (paragraph.length > maxChunkLength) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        
        for (const sentence of sentences) {
          // If adding this sentence would exceed the max length, save the current chunk and start a new one
          if (currentChunk.length + sentence.length > maxChunkLength && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
          }
          
          // If the sentence itself is too long, split it arbitrarily
          if (sentence.length > maxChunkLength) {
            let remainingSentence = sentence;
            while (remainingSentence.length > 0) {
              const chunk = remainingSentence.substring(0, maxChunkLength);
              chunks.push(chunk.trim());
              remainingSentence = remainingSentence.substring(maxChunkLength);
            }
          } else {
            currentChunk += sentence + ' ';
          }
        }
      } else {
        currentChunk += paragraph + '\n\n';
      }
    }
    
    // Add the last chunk if it's not empty
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }
}

// Export singleton instance
export const embeddingService = new EmbeddingService();