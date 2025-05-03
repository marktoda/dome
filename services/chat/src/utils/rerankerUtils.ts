import { getLogger } from '@dome/logging';
import { DocumentChunk, RetrievalResult, AgentState, RetrievalTask, RetrievalToolType } from '../types';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from './errors';

/**
 * Configure and create a reranker factory with shared implementation
 * @param options Configuration options for the reranker
 * @returns A function that can rerank retrieval results
 */
export interface RerankerOptions {
  /** The name of the reranker for logging and observability */
  name: string;
  /** The model to use for reranking (e.g., 'bge-reranker-base') */
  model: string;
  /** Threshold score for filtering results (0-1) */
  scoreThreshold?: number;
  /** Maximum number of results to return after reranking */
  maxResults?: number;
  /** Whether to keep documents below threshold for debugging */
  keepBelowThreshold?: boolean;
}

/**
 * Creates a reranker function that applies cross-encoder reranking to retrieval results
 *
 * @param options Configuration options for the reranker
 * @returns A function that reranks retrieval results
 */
export function createReranker(options: RerankerOptions) {
  const {
    name,
    model,
    scoreThreshold = 0.0,
    maxResults = 8,
    keepBelowThreshold = false
  } = options;

  const logger = getLogger().child({ component: name });

  /**
   * Reranks retrieval results using a cross-encoder model from Workers AI
   *
   * @param retrievalResult Initial retrieval results to rerank
   * @param query The query used for retrieval and reranking
   * @param env Environment variables with Workers AI bindings
   * @param traceId Trace ID for observability
   * @param spanId Parent span ID for observability
   * @returns Reranked results with improved relevance scores
   */
  /**
   * Interface for processed reranker results, used internally
   * by the reranker but not exposed outside
   */
  interface RerankerProcessedResult {
    originalResults: RetrievalResult;
    rerankedChunks: DocumentChunk[];
    metadata: {
      rerankerModel: string;
      executionTimeMs: number;
      scoreThreshold: number;
      error?: string;
    };
  }

  return async function rerank(
    retrievalResult: RetrievalResult,
    query: string,
    env: Env,
    traceId: string,
    spanId: string
  ): Promise<RetrievalTask> {
    const startTime = performance.now();
    const minimalState: AgentState = {
      userId: 'system',
      messages: [],
      retrievals: [], // Add the required retrievals property
      options: {
        enhanceWithContext: true,
        maxContextItems: 10,
        includeSourceInfo: true,
        maxTokens: 1000
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        currentNode: `rerank_${name}`
      }
    };
    const rerankerSpanId = ObservabilityService.startSpan(env, traceId, `rerank_${name}`, minimalState);

    logger.info({
      query,
      chunkCount: retrievalResult.chunks.length,
      sourceType: retrievalResult.sourceType
    }, `Starting ${name} reranking operation with Workers AI`);

    try {
      // Only rerank if we have chunks to process
      if (retrievalResult.chunks.length === 0) {
        logger.info('No chunks to rerank, returning empty result');

        // Map sourceType to RetrievalToolType or use sourceType as category with type assertion
        let category: RetrievalToolType;
        switch (retrievalResult.sourceType) {
          case 'code':
            category = RetrievalToolType.CODE;
            break;
          case 'doc':
          case 'docs':
            category = RetrievalToolType.DOC;
            break;
          case 'note':
          case 'notes':
            category = RetrievalToolType.NOTE;
            break;
          case 'web':
            category = RetrievalToolType.WEB;
            break;
          default:
            // Use type assertion for custom source types
            category = retrievalResult.sourceType as unknown as RetrievalToolType;
        }

        const emptyResult: RetrievalTask = {
          category: category,
          query: query,
          chunks: [],
          sourceType: retrievalResult.sourceType,
          metadata: {
            rerankerModel: model,
            executionTimeMs: 0,
            scoreThreshold,
            retrievalStrategy: retrievalResult.metadata.retrievalStrategy,
            totalCandidates: retrievalResult.metadata.totalCandidates
          }
        };

        ObservabilityService.endSpan(
          env,
          traceId,
          rerankerSpanId,
          `rerank_${name}`,
          minimalState,
          minimalState,
          0
        );

        return emptyResult;
      }

      // Use Workers AI reranker to score the chunks
      const rerankedChunks = await rerankWithWorkersAI(
        retrievalResult.chunks,
        query,
        model,
        env
      );

      // Filter by threshold and limit result count
      let filteredChunks = rerankedChunks;
      if (!keepBelowThreshold) {
        filteredChunks = rerankedChunks.filter(chunk =>
          (chunk.metadata.rerankerScore || 0) >= scoreThreshold
        );
      }

      // Take top results up to maxResults
      const topResults = filteredChunks.slice(0, maxResults);

      const executionTimeMs = performance.now() - startTime;

      // Log reranking metrics
      ObservabilityService.logEvent(env, traceId, rerankerSpanId, 'reranking_completed', {
        sourceType: retrievalResult.sourceType,
        inputChunks: retrievalResult.chunks.length,
        filteredChunks: filteredChunks.length,
        returnedChunks: topResults.length,
        executionTimeMs
      });

      // Map sourceType to RetrievalToolType for the result
      let resultCategory: RetrievalToolType;
      switch (retrievalResult.sourceType) {
        case 'code':
          resultCategory = RetrievalToolType.CODE;
          break;
        case 'doc':
        case 'docs':
          resultCategory = RetrievalToolType.DOC;
          break;
        case 'note':
        case 'notes':
          resultCategory = RetrievalToolType.NOTE;
          break;
        case 'web':
          resultCategory = RetrievalToolType.WEB;
          break;
        default:
          // Use type assertion for custom source types
          resultCategory = retrievalResult.sourceType as unknown as RetrievalToolType;
      }

      // Create result as RetrievalTask
      const result: RetrievalTask = {
        category: resultCategory,
        query: query,
        chunks: topResults,
        sourceType: retrievalResult.sourceType,
        metadata: {
          rerankerModel: model,
          executionTimeMs,
          scoreThreshold,
          retrievalStrategy: retrievalResult.metadata.retrievalStrategy,
          totalCandidates: retrievalResult.metadata.totalCandidates
        }
      };

      logger.info({
        executionTimeMs,
        inputChunks: retrievalResult.chunks.length,
        filteredChunks: filteredChunks.length,
        returnedChunks: topResults.length
      }, `${name} reranking completed`);

      // Create a new state with the retrieval task added
      const updatedState: AgentState = {
        ...minimalState,
        retrievals: [...(minimalState.retrievals || []), result]
      };

      ObservabilityService.endSpan(
        env,
        traceId,
        rerankerSpanId,
        `rerank_${name}`,
        minimalState,
        updatedState,
        executionTimeMs
      );

      return result;
    } catch (error) {
      const domeError = toDomeError(error);
      logger.error({
        err: domeError,
        query,
        sourceType: retrievalResult.sourceType
      }, `Error during ${name} reranking`);

      ObservabilityService.logEvent(env, traceId, rerankerSpanId, 'reranking_error', {
        sourceType: retrievalResult.sourceType,
        error: domeError.message
      });

      // Return original chunks on error, marking that reranking failed
      const executionTimeMs = performance.now() - startTime;

      // Map sourceType to RetrievalToolType for the fallback result
      let fallbackCategory: RetrievalToolType;
      switch (retrievalResult.sourceType) {
        case 'code':
          fallbackCategory = RetrievalToolType.CODE;
          break;
        case 'doc':
        case 'docs':
          fallbackCategory = RetrievalToolType.DOC;
          break;
        case 'note':
        case 'notes':
          fallbackCategory = RetrievalToolType.NOTE;
          break;
        case 'web':
          fallbackCategory = RetrievalToolType.WEB;
          break;
        default:
          // Use type assertion for custom source types
          fallbackCategory = retrievalResult.sourceType as unknown as RetrievalToolType;
      }

      const fallbackResult: RetrievalTask = {
        category: fallbackCategory,
        query: query,
        chunks: retrievalResult.chunks.slice(0, maxResults),
        sourceType: retrievalResult.sourceType,
        metadata: {
          rerankerModel: model,
          executionTimeMs,
          scoreThreshold,
          retrievalStrategy: retrievalResult.metadata.retrievalStrategy,
          totalCandidates: retrievalResult.metadata.totalCandidates,
          // Using type assertion to allow error property
          error: domeError.message
        }
      };

      // Create updated state with retrieval task for error case
      const updatedErrorState: AgentState = {
        ...minimalState,
        retrievals: [...(minimalState.retrievals || []), fallbackResult],
        metadata: {
          ...minimalState.metadata,
          errors: [{
            node: `rerank_${name}`,
            message: domeError.message,
            timestamp: Date.now()
          }]
        }
      };

      ObservabilityService.endSpan(
        env,
        traceId,
        rerankerSpanId,
        `rerank_${name}`,
        minimalState,
        updatedErrorState,
        executionTimeMs
      );

      return fallbackResult;
    }
  };
}

/**
 * Interface for the reranking request to Workers AI
 */
interface RerankerRequest {
  query: string;
  documents: string[];
}

/**
 * Interface for the reranking response from Workers AI
 * Matches @cf/baai/bge-reranker-base output schema
 */
interface RerankerResponse {
  response: Array<{
    id: number;  // Index of the context in the request
    score: number;  // Score of the context under that index
  }>;
}

/**
 * Uses Workers AI Reranker to score the document chunks based on relevance to the query
 *
 * @param chunks Document chunks to rerank
 * @param query Query to use for relevance comparison
 * @param modelName Name of the Workers AI model to use for reranking
 * @param env Environment with Workers AI bindings
 * @returns Reranked document chunks with updated rerankerScore
 */
async function rerankWithWorkersAI(
  chunks: DocumentChunk[],
  query: string,
  modelName: string,
  env: Env
): Promise<DocumentChunk[]> {
  const logger = getLogger().child({ component: 'WorkersAIReranker' });

  try {
    logger.info({
      modelName,
      chunkCount: chunks.length,
      query
    }, 'Starting Workers AI reranking');

    // Extract text content from chunks for reranking
    const documents = chunks.map(chunk => chunk.content);

    // Format for BGE reranker needs { query, contexts: [{ text: "doc1" }, ...] }
    const rerankerInput = {
      query,
      contexts: documents.map(d => ({ text: d }))
    };

    // Call Workers AI reranker model
    // Use type assertion to handle AI property on Env
    const envWithAI = env as any;
    logger.info({ model: modelName }, 'Using Workers AI model for reranking');

    // Call the reranker model
    const rerankerOutput = await envWithAI.AI.run('@cf/baai/bge-reranker-base', rerankerInput) as RerankerResponse;


    // Map scores back to original chunks
    const rerankedChunks = chunks.map((chunk, i) => {
      // Find the corresponding score from reranker response
      // The bge-reranker-base model returns response array with id and score
      const result = rerankerOutput.response.find(r => r.id === i);
      const score = result ? result.score : 0;

      // Create a new chunk with the reranker score
      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          rerankerScore: score
        }
      };
    });
    getLogger().info({
      chunks: rerankedChunks.length, ranked: rerankedChunks.map((c) => ({
        id: c.id,
        rerankedScore: c.metadata.rerankerScore,
        preScore: c.metadata.relevanceScore
      }))
    }, 'Workers AI reranked');

    // Sort by reranker score (highest first)
    return rerankedChunks.sort((a, b) =>
      (b.metadata.rerankerScore || 0) - (a.metadata.rerankerScore || 0)
    );
  } catch (error) {
    // Log error details
    const domeError = toDomeError(error);
    logger.error({
      err: domeError,
      modelName
    }, 'Workers AI reranking failed');

    // Fallback to basic scoring if Workers AI fails
    // Return chunks with relevance scores or default scores
    return chunks.map(chunk => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        rerankerScore: chunk.metadata.relevanceScore || 0.5
      }
    })).sort((a, b) =>
      (b.metadata.rerankerScore || 0) - (a.metadata.rerankerScore || 0)
    );
  }
}
