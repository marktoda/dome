import { getLogger } from '@dome/common';
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

      // Filter by appropriate threshold based on source type
      let filteredChunks = rerankedChunks;
      if (!keepBelowThreshold) {
        filteredChunks = rerankedChunks.filter(chunk => {
          // Get the appropriate threshold for this content type
          const contentType = chunk.metadata.sourceType as string || 'note';
          const sourceThreshold = SOURCE_THRESHOLDS[contentType as keyof typeof SOURCE_THRESHOLDS] || scoreThreshold;
          
          // Use hybridScore for filtering if available, otherwise fall back to rerankerScore
          // Using type assertion since we added these properties dynamically
          const hybridScore = (chunk.metadata as any).hybridScore;
          const rerankerScore = chunk.metadata.rerankerScore || 0;
          const scoreToUse = hybridScore !== undefined ? hybridScore : rerankerScore;
            
          return scoreToUse >= sourceThreshold;
        });
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
 * Map to store per-source score thresholds for different content types
 */
const SOURCE_THRESHOLDS = {
  code: 0.3,   // Code generally scores lower
  docs: 0.55,  // Documentation tends to score higher
  note: 0.4,   // Notes often score in the middle range
  notes: 0.4,  // Alias for note
  web: 0.5     // Web content generally scores well
};

/**
 * Apply logistic function to map raw logit scores to [0,1] range
 * BGE reranker scores are typically in range [-5, 10], this maps to [0.007, 0.9999]
 *
 * @param x Raw logit score from the reranker
 * @returns Normalized score in [0,1] range
 */
function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Clean text input to remove markup and code fencing that might confuse the reranker
 *
 * @param text Input text to clean
 * @returns Cleaned text with code blocks and HTML tags simplified
 */
function cleanTextForReranker(text: string): string {
  // Replace code blocks with simplified <code> tag
  const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, "<code>");
  
  // Remove HTML tags
  const withoutHtml = withoutCodeBlocks.replace(/<[^>]+>/g, "");
  
  // Truncate to reasonable length for reranker (about 300 tokens)
  return withoutHtml.slice(0, 1500);
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

    // Clean and truncate the query
    const cleanedQuery = cleanTextForReranker(query).slice(0, 500);
    
    // Clean and truncate content from chunks for reranking
    const cleanedChunks = chunks.map(chunk => ({
      ...chunk,
      cleanedContent: cleanTextForReranker(chunk.content)
    }));

    // Format for BGE reranker needs { query, contexts: [{ text: "doc1" }, ...] }
    const rerankerInput = {
      query: cleanedQuery,
      contexts: cleanedChunks.map(c => ({ text: c.cleanedContent }))
    };
    logger.info({ rerankerInput }, '[DEBUG] Workers AI reranking');

    // Determine which model to use based on content type
    // Use bge-reranker-large for code or bge-m3 for potential multilingual content
    const sourceType = chunks[0]?.metadata?.sourceType as string || '';
    const isCodeContent = sourceType === 'code' || query.toLowerCase().includes('code');
    
    // Choose appropriate model based on content
    const effectiveModel = isCodeContent ? '@cf/baai/bge-reranker-large' : modelName;
    
    logger.info({ model: effectiveModel }, 'Using Workers AI model for reranking');

    // Call Workers AI reranker model
    const envWithAI = env as any;
    const rerankerOutput = await envWithAI.AI.run(effectiveModel, rerankerInput) as RerankerResponse;
    logger.info({ rerankerOutput }, '[DEBUG] Workers AI reranking');

    // Check for unusually low scores across all results
    const allScoresLow = rerankerOutput.response.every(r => r.score < -2);
    
    // Get source type for threshold lookup
    const contentType = chunks[0]?.metadata?.sourceType || 'note';
    // Get source-specific threshold or default to 0.45
    const sourceThreshold = SOURCE_THRESHOLDS[contentType as keyof typeof SOURCE_THRESHOLDS] || 0.45;
    
    // Map scores back to original chunks with normalization
    const rerankedChunks = chunks.map((chunk, i) => {
      // Find the corresponding score from reranker response
      const result = rerankerOutput.response.find(r => r.id === i);
      const rawScore = result ? result.score : -5; // Default to very low score if missing
      
      // Normalize raw score with logistic function
      const normalizedScore = logistic(rawScore);
      
      // Calculate hybrid score (70% reranker, 30% original vector score)
      const vectorScore = chunk.metadata.relevanceScore || 0.5;
      const hybridScore = allScoresLow
        ? vectorScore  // If all scores are very low, fall back to vector scores
        : 0.7 * normalizedScore + 0.3 * vectorScore;
      
      // Create a new chunk with all score information
      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          rerankerRawScore: rawScore,           // Original BGE score (-5 to 10 range)
          rerankerScore: normalizedScore,       // Normalized to 0-1 range
          hybridScore: hybridScore,             // Combined score
          sourceThreshold: sourceThreshold      // The threshold for this content type
        }
      };
    });
    
    getLogger().info({
      chunks: rerankedChunks.length,
      ranked: rerankedChunks.map((c) => ({
        id: c.id,
        sourceType: c.metadata.sourceType,
        rawScore: c.metadata.rerankerRawScore,
        normalizedScore: c.metadata.rerankerScore,
        hybridScore: c.metadata.hybridScore,
        vectorScore: c.metadata.relevanceScore
      }))
    }, 'Workers AI reranked');

    // Sort by hybrid score (highest first)
    return rerankedChunks.sort((a, b) =>
      (b.metadata.hybridScore || 0) - (a.metadata.hybridScore || 0)
    );
  } catch (error) {
    // Log error details
    const domeError = toDomeError(error);
    logger.error({
      err: domeError,
      modelName
    }, 'Workers AI reranking failed');

    // Fallback to basic scoring if Workers AI fails
    // Return chunks with relevance scores as hybrid scores
    return chunks.map(chunk => {
      const contentType = chunk.metadata.sourceType as string || 'note';
      const sourceThreshold = SOURCE_THRESHOLDS[contentType as keyof typeof SOURCE_THRESHOLDS] || 0.45;
      const vectorScore = chunk.metadata.relevanceScore || 0.5;
      
      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          rerankerRawScore: 0,
          rerankerScore: vectorScore,
          hybridScore: vectorScore,
          sourceThreshold: sourceThreshold
        }
      };
    }).sort((a, b) =>
      (b.metadata.hybridScore || 0) - (a.metadata.hybridScore || 0)
    );
  }
}
