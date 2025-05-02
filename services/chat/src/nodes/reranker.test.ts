import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reranker, createCategoryReranker } from './reranker';
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
    code: 'ERR_RERANKER',
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

describe('Unified Reranker Node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockConfig: any;
  let mockCodeChunks: DocumentChunk[];
  let mockDocsChunks: DocumentChunk[];
  let mockNotesChunks: DocumentChunk[];
  let mockCodeRetrievalResult: RetrievalResult;
  let mockDocsRetrievalResult: RetrievalResult;
  let mockNotesRetrievalResult: RetrievalResult;
  let mockReranker: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup mock code data
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
    ];
    
    // Setup mock docs data
    mockDocsChunks = [
      {
        id: 'docs-1',
        content: 'Binary search trees are efficient data structures for lookups.',
        metadata: {
          source: 'documentation',
          sourceType: 'docs',
          title: 'BST Documentation',
          relevanceScore: 0.85,
        }
      },
      {
        id: 'docs-2',
        content: 'Time complexity for search operations is O(log n) on average.',
        metadata: {
          source: 'documentation',
          sourceType: 'docs',
          title: 'BST Performance',
          relevanceScore: 0.79,
        }
      },
    ];
    
    // Setup mock notes data
    mockNotesChunks = [
      {
        id: 'notes-1',
        content: 'Personal notes on BST implementation: Remember to handle duplicates.',
        metadata: {
          source: 'notes',
          sourceType: 'notes',
          title: 'BST Notes',
          relevanceScore: 0.75,
        }
      },
    ];
    
    mockCodeRetrievalResult = {
      query: 'How do I implement a binary search tree in Python?',
      chunks: mockCodeChunks,
      sourceType: 'code',
      metadata: {
        executionTimeMs: 100,
        retrievalStrategy: 'vector',
        totalCandidates: 2
      }
    };
    
    mockDocsRetrievalResult = {
      query: 'How do I implement a binary search tree in Python?',
      chunks: mockDocsChunks,
      sourceType: 'docs',
      metadata: {
        executionTimeMs: 90,
        retrievalStrategy: 'vector',
        totalCandidates: 2
      }
    };
    
    mockNotesRetrievalResult = {
      query: 'How do I implement a binary search tree in Python?',
      chunks: mockNotesChunks,
      sourceType: 'notes',
      metadata: {
        executionTimeMs: 80,
        retrievalStrategy: 'vector',
        totalCandidates: 1
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
      retrievals: [], // Required by AgentState type
      retrievalResults: {
        code: mockCodeRetrievalResult,
        docs: mockDocsRetrievalResult,
        notes: mockNotesRetrievalResult
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
    const mockRerankedCodeChunks = [
      {
        ...mockCodeChunks[0],
        metadata: {
          ...mockCodeChunks[0].metadata,
          rerankerScore: 0.95,
        }
      },
      {
        ...mockCodeChunks[1],
        metadata: {
          ...mockCodeChunks[1].metadata,
          rerankerScore: 0.88,
        }
      },
    ];
    
    // Mock the reranker function
    mockReranker = vi.fn().mockResolvedValue({
      originalResults: mockCodeRetrievalResult,
      rerankedChunks: mockRerankedCodeChunks,
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
    const result = await reranker(mockState, 'code', mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.rerankedResults).toBeDefined();
    expect(result.rerankedResults?.code).toBeDefined();
    
    // Check that the reranked chunks are returned
    expect(result.rerankedResults?.code?.rerankedChunks).toBeDefined();
    expect(result.rerankedResults?.code?.rerankedChunks[0].id).toBe('code-1');
    
    // Verify createReranker was called with correct parameters
    expect(rerankerUtils.createReranker).toHaveBeenCalledWith({
      name: 'code',
      model: 'bge-reranker-code',
      scoreThreshold: 0.25,
      maxResults: 8
    });
    
    // Verify reranker was called with correct parameters
    expect(mockReranker).toHaveBeenCalledWith(
      mockCodeRetrievalResult,
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

  it('should rerank docs snippets with correct model and configuration', async () => {
    // Update the mock reranker to return docs-specific results
    mockReranker.mockResolvedValueOnce({
      originalResults: mockDocsRetrievalResult,
      rerankedChunks: [
        {
          ...mockDocsChunks[0],
          metadata: {
            ...mockDocsChunks[0].metadata,
            rerankerScore: 0.93,
          }
        },
        {
          ...mockDocsChunks[1],
          metadata: {
            ...mockDocsChunks[1].metadata,
            rerankerScore: 0.86,
          }
        }
      ],
      metadata: {
        rerankerModel: 'bge-reranker-docs',
        executionTimeMs: 45,
        scoreThreshold: 0.22
      }
    });
    
    // Execute the node for docs
    const result = await reranker(mockState, 'docs', mockConfig, mockEnv);
    
    // Verify the result
    expect(result.rerankedResults?.docs).toBeDefined();
    
    // Verify createReranker was called with correct parameters for docs
    expect(rerankerUtils.createReranker).toHaveBeenCalledWith({
      name: 'docs',
      model: 'bge-reranker-docs',
      scoreThreshold: 0.22,
      maxResults: 8
    });
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'docsReranker',
      executionTimeMs: expect.any(Number),
    });
  });

  it('should rerank notes snippets with correct model and configuration', async () => {
    // Update the mock reranker to return notes-specific results
    mockReranker.mockResolvedValueOnce({
      originalResults: mockNotesRetrievalResult,
      rerankedChunks: [
        {
          ...mockNotesChunks[0],
          metadata: {
            ...mockNotesChunks[0].metadata,
            rerankerScore: 0.89,
          }
        }
      ],
      metadata: {
        rerankerModel: 'bge-reranker-notes',
        executionTimeMs: 40,
        scoreThreshold: 0.2
      }
    });
    
    // Execute the node for notes
    const result = await reranker(mockState, 'notes', mockConfig, mockEnv);
    
    // Verify the result
    expect(result.rerankedResults?.notes).toBeDefined();
    
    // Verify createReranker was called with correct parameters for notes
    expect(rerankerUtils.createReranker).toHaveBeenCalledWith({
      name: 'notes',
      model: 'bge-reranker-notes',
      scoreThreshold: 0.2,
      maxResults: 8
    });
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'notesReranker',
      executionTimeMs: expect.any(Number),
    });
  });

  it('should skip processing if no category-specific retrieval results exist', async () => {
    // Setup state with no code retrieval results
    const stateWithoutCodeResults = {
      ...mockState,
      retrievalResults: {
        docs: mockDocsRetrievalResult,
        notes: mockNotesRetrievalResult
      },
      retrievals: [] // Required by AgentState type
    };
    
    // Execute the node for code
    const result = await reranker(stateWithoutCodeResults, 'code', mockConfig, mockEnv);
    
    // Verify no reranking was done
    expect(result.rerankedResults?.code).toBeUndefined();
    
    // Verify metadata still shows execution
    expect(result.metadata).toMatchObject({
      currentNode: 'codeReranker',
      executionTimeMs: 0,
    });
  });

  it('should handle empty retrieval results for a category', async () => {
    // Setup state with empty code retrieval results
    const stateWithEmptyResults = {
      ...mockState,
      retrievalResults: {
        ...mockState.retrievalResults,
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
      },
      retrievals: [] // Required by AgentState type
    };
    
    // Execute the node
    const result = await reranker(stateWithEmptyResults, 'code', mockConfig, mockEnv);
    
    // Verify reranking was attempted
    expect(rerankerUtils.createReranker).toHaveBeenCalled();
    expect(mockReranker).toHaveBeenCalled();
  });

  it('should handle errors during reranking gracefully', async () => {
    // Make the reranker throw an error
    mockReranker.mockRejectedValueOnce(new Error('Reranking error'));
    
    // Execute the node
    const result = await reranker(mockState, 'code', mockConfig, mockEnv);
    
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
      messages: [],
      retrievals: [] // Required by AgentState type
    };
    
    // Execute the node
    const result = await reranker(stateWithoutMessages, 'code', mockConfig, mockEnv);
    
    // Verify no reranking was done
    expect(result.rerankedResults?.code).toBeUndefined();
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'codeReranker',
      executionTimeMs: 0,
    });
  });

  it('should support createCategoryReranker factory function for each content type', async () => {
    // Create specific rerankers
    const codeRerankerFn = createCategoryReranker('code');
    const docsRerankerFn = createCategoryReranker('docs');
    const notesRerankerFn = createCategoryReranker('notes');
    
    // Execute the code reranker
    const codeResult = await codeRerankerFn(mockState, mockConfig, mockEnv);
    
    // Verify the reranker was called with 'code' category
    expect(rerankerUtils.createReranker).toHaveBeenCalledWith(expect.objectContaining({
      name: 'code',
      model: 'bge-reranker-code'
    }));
    
    // Reset mocks for next test
    vi.clearAllMocks();
    
    // Update the mock reranker for docs
    mockReranker.mockResolvedValueOnce({
      originalResults: mockDocsRetrievalResult,
      rerankedChunks: mockDocsChunks,
      metadata: {
        rerankerModel: 'bge-reranker-docs',
        executionTimeMs: 45,
        scoreThreshold: 0.22
      }
    });
    
    vi.mocked(rerankerUtils.createReranker).mockReturnValue(mockReranker);
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('span-123');
    
    // Execute the docs reranker
    await docsRerankerFn(mockState, mockConfig, mockEnv);
    
    // Verify the reranker was called with 'docs' category
    expect(rerankerUtils.createReranker).toHaveBeenCalledWith(expect.objectContaining({
      name: 'docs',
      model: 'bge-reranker-docs'
    }));
  });
});