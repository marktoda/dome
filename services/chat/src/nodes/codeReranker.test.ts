import { describe, it, expect, vi, beforeEach } from 'vitest';
import { codeReranker } from './codeReranker';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState, DocumentChunk, RetrievalResult } from '../types';
import * as rerankerUtils from '../utils/rerankerUtils';

// Mock dependencies
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  })),
  logError: vi.fn(),
}));

vi.mock('../services/observabilityService');
vi.mock('../utils/errors', () => ({
  toDomeError: vi.fn((error) => ({
    message: error instanceof Error ? error.message : 'Unknown error',
    code: 'ERR_CODE_RERANKER',
  })),
}));

vi.mock('../utils/rerankerUtils');

// Mock performance API
global.performance = {
  now: vi.fn()
    .mockReturnValueOnce(100) // Start time
    .mockReturnValueOnce(250), // End time (150ms elapsed)
} as any;

// Mock crypto.randomUUID instead of replacing the entire crypto object
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => '123e4567-e89b-12d3-a456-426614174000');

describe('codeReranker Node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockConfig: any;
  let mockCodeChunks: DocumentChunk[];
  let mockRetrievalResult: RetrievalResult;
  let mockReranker: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup mock data
    mockCodeChunks = [
      {
        id: 'code-1',
        content: 'class BinarySearchTree:\n    def __init__(self):\n        self.root = None',
        metadata: {
          source: 'github',
          sourceType: 'code',
          language: 'python',
          title: 'BST Implementation',
          relevanceScore: 0.82,
        }
      },
      {
        id: 'code-2',
        content: 'def insert(self, value):\n    if self.root is None:\n        self.root = Node(value)',
        metadata: {
          source: 'github',
          sourceType: 'code',
          language: 'python',
          title: 'BST Insert Method',
          relevanceScore: 0.78,
        }
      },
      {
        id: 'code-3',
        content: 'def search(self, value):\n    return self._search(self.root, value)',
        metadata: {
          source: 'github',
          sourceType: 'code',
          language: 'python',
          title: 'BST Search Method',
          relevanceScore: 0.75,
        }
      }
    ];
    
    mockRetrievalResult = {
      query: 'How do I implement a binary search tree in Python?',
      chunks: mockCodeChunks,
      sourceType: 'code',
      metadata: {
        executionTimeMs: 100,
        retrievalStrategy: 'vector',
        totalCandidates: 3
      }
    };
    
    mockState = {
      userId: 'user-123',
      messages: [
        { role: 'user', content: 'How do I implement a binary search tree in Python?' }
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      retrievalResults: {
        code: mockRetrievalResult
      },
      metadata: {
        traceId: 'trace-123',
      }
    };
    
    mockEnv = { 
      OPENAI_API_KEY: 'mock-api-key',
    };
    
    mockConfig = {};
    
    // Mock reranked results with improved scores
    const rerankedChunks = [
      {
        ...mockCodeChunks[0],
        metadata: {
          ...mockCodeChunks[0].metadata,
          rerankerScore: 0.95,
        }
      },
      {
        ...mockCodeChunks[2],
        metadata: {
          ...mockCodeChunks[2].metadata,
          rerankerScore: 0.88,
        }
      },
      {
        ...mockCodeChunks[1],
        metadata: {
          ...mockCodeChunks[1].metadata,
          rerankerScore: 0.82,
        }
      }
    ];
    
    // Mock the reranker function
    mockReranker = vi.fn().mockResolvedValue({
      originalResults: mockRetrievalResult,
      rerankedChunks,
      metadata: {
        rerankerModel: 'bge-reranker-code',
        executionTimeMs: 50,
        scoreThreshold: 0.25
      }
    });
    
    vi.mocked(rerankerUtils.createReranker).mockReturnValue(mockReranker);
    
    // Mock ObservabilityService
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('span-123');
    vi.mocked(ObservabilityService.endSpan).mockImplementation(() => {});
  });

  it('should rerank code snippets based on relevance', async () => {
    // Execute the node
    const result = await codeReranker(mockState, mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.rerankedResults).toBeDefined();
    expect(result.rerankedResults?.code).toBeDefined();
    
    // Check that the reranked chunks are returned in the correct order
    expect(result.rerankedResults?.code?.rerankedChunks).toBeDefined();
    expect(result.rerankedResults?.code?.rerankedChunks[0].id).toBe('code-1');
    expect(result.rerankedResults?.code?.rerankedChunks[1].id).toBe('code-3');
    expect(result.rerankedResults?.code?.rerankedChunks[2].id).toBe('code-2');
    
    // Verify createReranker was called with correct parameters
    expect(rerankerUtils.createReranker).toHaveBeenCalledWith({
      name: 'code',
      model: 'bge-reranker-code',
      scoreThreshold: 0.25,
      maxResults: 8
    });
    
    // Verify reranker was called with correct parameters
    expect(mockReranker).toHaveBeenCalledWith(
      mockRetrievalResult,
      'How do I implement a binary search tree in Python?',
      mockEnv,
      'trace-123',
      'span-123'
    );
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'codeReranker',
      executionTimeMs: expect.any(Number),
    });
    
    // Verify observability service was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
  });

  it('should skip processing if no code retrieval results exist', async () => {
    // Setup state with no code retrieval results
    const stateWithoutCodeResults = {
      ...mockState,
      retrievalResults: {
        docs: {
          query: 'How do I implement a binary search tree in Python?',
          chunks: [],
          sourceType: 'docs',
          metadata: {
            executionTimeMs: 100,
            retrievalStrategy: 'vector',
            totalCandidates: 0
          }
        }
      }
    };
    
    // Execute the node
    const result = await codeReranker(stateWithoutCodeResults, mockConfig, mockEnv);
    
    // Verify no reranking was done
    expect(result.rerankedResults).toBeUndefined();
    expect(rerankerUtils.createReranker).not.toHaveBeenCalled();
    
    // Verify metadata still shows execution
    expect(result.metadata).toMatchObject({
      currentNode: 'codeReranker',
      executionTimeMs: 0,
    });
  });

  it('should handle empty retrieval results', async () => {
    // Setup state with empty code retrieval results
    const stateWithEmptyResults = {
      ...mockState,
      retrievalResults: {
        code: {
          query: 'How do I implement a binary search tree in Python?',
          chunks: [],
          sourceType: 'code',
          metadata: {
            executionTimeMs: 100,
            retrievalStrategy: 'vector',
            totalCandidates: 0
          }
        }
      }
    };
    
    // Execute the node
    const result = await codeReranker(stateWithEmptyResults, mockConfig, mockEnv);
    
    // Verify reranking was attempted
    expect(rerankerUtils.createReranker).toHaveBeenCalled();
    expect(mockReranker).toHaveBeenCalled();
  });

  it('should handle errors during reranking gracefully', async () => {
    // Make the reranker throw an error
    mockReranker.mockRejectedValueOnce(new Error('Reranking error'));
    
    // Execute the node
    const result = await codeReranker(mockState, mockConfig, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'codeReranker',
      message: 'Reranking error',
    });
    
    // Verify ObservabilityService.endSpan was called with error context
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
  });

  it('should handle state with no user messages', async () => {
    // Setup state with no user messages
    const stateWithoutMessages = {
      ...mockState,
      messages: []
    };
    
    // Execute the node
    const result = await codeReranker(stateWithoutMessages, mockConfig, mockEnv);
    
    // Verify no reranking was done
    expect(result.rerankedResults).toBeUndefined();
    expect(rerankerUtils.createReranker).not.toHaveBeenCalled();
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'codeReranker',
      executionTimeMs: 0,
    });
  });
});