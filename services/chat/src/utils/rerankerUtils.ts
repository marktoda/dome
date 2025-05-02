import { getLogger } from '@dome/logging';
import { DocumentChunk, RetrievalResult, RerankedResult, AgentState } from '../types';
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
  /** The model to use for reranking (e.g., 'bge-reranker', 'cohere-rerank') */
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
    scoreThreshold = 0.2,
    maxResults = 8,
    keepBelowThreshold = false
  } = options;
  
  const logger = getLogger().child({ component: name });
  
  /**
   * Reranks retrieval results using a cross-encoder model
   * 
   * @param retrievalResult Initial retrieval results to rerank
   * @param query The query used for retrieval and reranking
   * @param env Environment variables
   * @param traceId Trace ID for observability
   * @param spanId Parent span ID for observability
   * @returns Reranked results with improved relevance scores
   */
  return async function rerank(
    retrievalResult: RetrievalResult,
    query: string,
    env: Env,
    traceId: string,
    spanId: string
  ): Promise<RerankedResult> {
    const startTime = performance.now();
    const minimalState: AgentState = {
      userId: 'system',
      messages: [],
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
    }, `Starting ${name} reranking operation`);
    
    try {
      // Only rerank if we have chunks to process
      if (retrievalResult.chunks.length === 0) {
        logger.info('No chunks to rerank, returning empty result');
        
        const emptyResult: RerankedResult = {
          originalResults: retrievalResult,
          rerankedChunks: [],
          metadata: {
            rerankerModel: model,
            executionTimeMs: 0,
            scoreThreshold
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
      
      // In a real implementation, this would call an actual reranker model API
      // Here we're simulating the reranking process
      const rerankedChunks = await simulateReranking(
        retrievalResult.chunks,
        query,
        retrievalResult.sourceType,
        model
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
      
      // Create result
      const result: RerankedResult = {
        originalResults: retrievalResult,
        rerankedChunks: topResults,
        metadata: {
          rerankerModel: model,
          executionTimeMs,
          scoreThreshold
        }
      };
      
      logger.info({
        executionTimeMs,
        inputChunks: retrievalResult.chunks.length,
        filteredChunks: filteredChunks.length,
        returnedChunks: topResults.length
      }, `${name} reranking completed`);
      
      ObservabilityService.endSpan(
        env,
        traceId,
        rerankerSpanId,
        `rerank_${name}`,
        minimalState,
        {
          ...minimalState,
          rerankedResults: { [retrievalResult.sourceType]: result }
        },
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
      const fallbackResult: RerankedResult = {
        originalResults: retrievalResult,
        rerankedChunks: retrievalResult.chunks.slice(0, maxResults),
        metadata: {
          rerankerModel: model,
          executionTimeMs,
          scoreThreshold,
          // Using type assertion to allow error property
          error: domeError.message
        } as any
      };
      
      ObservabilityService.endSpan(
        env,
        traceId,
        rerankerSpanId,
        `rerank_${name}`,
        minimalState,
        {
          ...minimalState,
          metadata: {
            errors: [{
              node: `rerank_${name}`,
              message: domeError.message,
              timestamp: Date.now()
            }]
          }
        },
        executionTimeMs
      );
      
      return fallbackResult;
    }
  };
}

/**
 * Simulates the reranking process with a cross-encoder model
 * 
 * In a real implementation, this would call an external reranking API or library.
 * This implementation simulates the reranking process by:
 * 1. Calculating synthetic scores based on content features relevant to the source type
 * 2. Sorting chunks based on the calculated scores
 * 3. Adding rerankerScore to chunk metadata
 * 
 * @param chunks Document chunks to rerank
 * @param query Query to use for relevance comparison
 * @param sourceType Type of source being reranked (code, notes, docs)
 * @param model Model name to simulate
 * @returns Reranked document chunks with updated rerankerScore
 */
async function simulateReranking(
  chunks: DocumentChunk[],
  query: string,
  sourceType: string,
  model: string
): Promise<DocumentChunk[]> {
  // Normalize query for comparison
  const normalizedQuery = query.toLowerCase();
  const queryTerms = new Set(normalizedQuery.split(/\s+/).filter(term => term.length > 2));
  
  // Create a copy of chunks to avoid mutating the original
  const rerankedChunks = [...chunks].map(chunk => {
    const content = chunk.content.toLowerCase();
    let score = chunk.metadata.relevanceScore || 0.5; // Start with base score
    
    // Common scoring factors (for all source types)
    // Term frequency
    const termMatches = Array.from(queryTerms).filter(term => content.includes(term)).length;
    const termMatchScore = queryTerms.size > 0 ? termMatches / queryTerms.size : 0;
    
    // Exact phrase matching (higher weight)
    const exactPhraseBoost = content.includes(normalizedQuery) ? 0.2 : 0;
    
    // Source-specific scoring adjustments
    let sourceSpecificScore = 0;
    
    if (sourceType === 'code') {
      // For code, boost if content includes function definitions, classes, or code patterns
      if (/function\s+|class\s+|def\s+|import\s+|export\s+/.test(content)) {
        sourceSpecificScore += 0.15;
      }
      // Boost documentation comments
      if (/\/\*\*|\*\/|\/\/\/|#\s+|"""/.test(content)) {
        sourceSpecificScore += 0.1;
      }
    } else if (sourceType === 'notes') {
      // For notes, boost if content includes headers, bullet points, or important markers
      if (/^#|^\*|^\-|^>\s|important|note:|remember|key point/i.test(content)) {
        sourceSpecificScore += 0.15;
      }
      // Boost for recent notes (if timestamp available)
      if (chunk.metadata.createdAt) {
        const createdDate = new Date(chunk.metadata.createdAt);
        const now = new Date();
        const daysSince = (now.getTime() - createdDate.getTime()) / (1000 * 3600 * 24);
        if (daysSince < 7) {
          sourceSpecificScore += 0.1;
        }
      }
    } else if (sourceType === 'docs') {
      // For docs, boost if content includes headers, definitions, or key terms
      if (/^#|definition:|is defined as|refers to|means|overview|summary/i.test(content)) {
        sourceSpecificScore += 0.15;
      }
      // Boost for docs with titles that match query terms
      if (chunk.metadata.title) {
        const titleTerms = chunk.metadata.title.toLowerCase().split(/\s+/);
        const titleMatchCount = Array.from(queryTerms).filter(term => 
          titleTerms.some(titleTerm => titleTerm.includes(term))
        ).length;
        if (titleMatchCount > 0) {
          sourceSpecificScore += 0.1 * (titleMatchCount / queryTerms.size);
        }
      }
    }
    
    // Calculate final reranker score
    // Combine embedding score (initial retrieval), term matching, and source-specific boosts
    const embeddingScore = chunk.metadata.embeddingScore || score;
    const rerankerScore = Math.min(
      0.95, // Cap at 0.95 to avoid perfect 1.0 scores
      0.3 * embeddingScore + 0.4 * termMatchScore + 0.2 * exactPhraseBoost + 0.1 * sourceSpecificScore
    );
    
    // Add small random variation to avoid ties (0.02 max)
    const finalScore = Math.max(0, Math.min(0.95, rerankerScore + (Math.random() * 0.02)));
    
    // Return new chunk with updated score
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        rerankerScore: Number(finalScore.toFixed(4))
      }
    };
  });
  
  // Sort by reranker score (highest first)
  return rerankedChunks.sort((a, b) => 
    (b.metadata.rerankerScore || 0) - (a.metadata.rerankerScore || 0)
  );
}