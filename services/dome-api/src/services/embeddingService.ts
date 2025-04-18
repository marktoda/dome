import { Bindings } from '../types';
import { ServiceError } from '@dome/common';

/**
 * Configuration constants for the embedding service
 */
const DEFAULT_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_DIM = 768;
const MAX_BATCH = 20;
const MAX_TEXT_LENGTH = 8192;
const MIN_TEXT_LENGTH = 3;

/**
 * Response types for different embedding API formats
 */
interface WorkersAIResponse {
  data: number[][];
}

interface OpenAIResponse {
  data: {
    embedding: number[];
  }[];
}

type EmbeddingResponse = WorkersAIResponse | OpenAIResponse | unknown;

/**
 * Normalizes different vector response formats into a standard array of numbers
 *
 * @param resp - The response from the embedding API
 * @returns Normalized vector as number array or undefined if format is unknown
 */
function normaliseVectorResp(resp: EmbeddingResponse): number[] | undefined {
  if (Array.isArray((resp as WorkersAIResponse)?.data?.[0])) {
    return (resp as WorkersAIResponse).data[0];
  }
  
  if ((resp as OpenAIResponse)?.data?.[0]?.embedding) {
    return (resp as OpenAIResponse).data[0].embedding;
  }
  
  return undefined;
}

/**
 * Service for generating text embeddings using Cloudflare Workers AI
 */
export class EmbeddingService {
  /**
   * Creates a new EmbeddingService instance
   *
   * @param model - The embedding model to use
   * @param dimension - The expected dimension of the embedding vectors
   * @param maxBatch - Maximum number of texts to process in a single batch
   */
  constructor(
    private readonly model: string = DEFAULT_MODEL,
    private readonly dimension: number = DEFAULT_DIM,
    private readonly maxBatch: number = MAX_BATCH,
  ) {}

  /**
   * Generates an embedding vector for a single text
   *
   * @param env - Cloudflare Workers environment bindings
   * @param text - The text to generate an embedding for
   * @returns Promise resolving to the embedding vector
   * @throws ServiceError if the AI binding is missing or embedding generation fails
   */
  async generate(env: Bindings, text: string): Promise<number[]> {
    const processedText = this.preprocess(text);
    
    if (!env.AI) {
      throw new ServiceError('Workers AI binding missing', {
        context: { model: this.model }
      });
    }

    try {
      const resp = await env.AI.run(this.model, { text: processedText });
      const vector = normaliseVectorResp(resp);
      
      if (!vector) {
        throw new ServiceError('Invalid embedding response format', {
          context: {
            model: this.model,
            responseType: typeof resp,
            hasData: Boolean(resp && typeof resp === 'object' && 'data' in resp)
          }
        });
      }
      
      if (vector.length !== this.dimension) {
        throw new ServiceError('Embedding dimension mismatch', {
          context: {
            expected: this.dimension,
            received: vector.length,
            model: this.model
          }
        });
      }
      
      return vector;
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }
      
      throw new ServiceError('Failed to generate embedding', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {
          model: this.model,
          textLength: processedText.length
        }
      });
    }
  }

  /**
   * Generates embedding vectors for multiple texts
   *
   * @param env - Cloudflare Workers environment bindings
   * @param texts - Array of texts to generate embeddings for
   * @returns Promise resolving to an array of embedding vectors
   */
  async generateBatch(env: Bindings, texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    
    const results: number[][] = [];
    
    for (let i = 0; i < texts.length; i += this.maxBatch) {
      const batch = texts.slice(i, i + this.maxBatch);
      const batchVectors = await Promise.all(
        batch.map(text => this.generate(env, text))
      );
      results.push(...batchVectors);
    }
    
    return results;
  }

  /**
   * Splits text into chunks of a maximum size
   *
   * @param text - The text to split into chunks
   * @param maxChunk - Maximum size of each chunk in characters
   * @returns Array of text chunks
   */
  splitTextIntoChunks(text: string, maxChunk = 2048): string[] {
    const chunks: string[] = [];
    const paragraphs = text.split(/\n\s*\n/);
    let currentChunk = '';
    
    for (const paragraph of paragraphs) {
      // If adding this paragraph would exceed the max chunk size and we already have content,
      // push the current chunk and start a new one
      if (currentChunk.length + paragraph.length > maxChunk && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If the paragraph itself exceeds the max chunk size, split it
      if (paragraph.length > maxChunk) {
        for (let i = 0; i < paragraph.length; i += maxChunk) {
          chunks.push(paragraph.slice(i, i + maxChunk));
        }
      } else {
        currentChunk += paragraph + '\n\n';
      }
    }
    
    // Add any remaining content
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  /**
   * Preprocesses text for embedding generation
   *
   * @param text - The raw text to preprocess
   * @returns Processed text ready for embedding
   */
  private preprocess(text: string): string {
    // Normalize whitespace
    let processed = text.trim().replace(/\s+/g, ' ');
    
    // Handle very short inputs
    if (processed.length < MIN_TEXT_LENGTH) {
      processed = `${processed} ${processed} query search`;
    }
    
    // Truncate if too long
    if (processed.length > MAX_TEXT_LENGTH) {
      processed = processed.slice(0, MAX_TEXT_LENGTH);
    }
    
    return processed;
  }
}

/**
 * Singleton instance of the embedding service
 */
export const embeddingService = new EmbeddingService();
