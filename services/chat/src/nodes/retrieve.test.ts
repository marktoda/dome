// @ts-nocheck
import { retrieve } from './retrieve';
import { SearchService } from '../services/searchService';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState, Document } from '../types';

// Mock implementations
jest.mock('../services/searchService');
jest.mock('../services/observabilityService');
jest.mock('@dome/logging', () => ({
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  }),
}));

describe('retrieve node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockDocuments: Document[];

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup test data
    mockState = {
      userId: 'test-user-id',
      messages: [],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      tasks: {
        originalQuery: 'test query',
        rewrittenQuery: 'enhanced test query',
      },
      metadata: {
        traceId: 'test-trace-id',
        startTime: Date.now(),
      },
    };

    mockEnv = {
      CONSTELLATION: {},
      SILO: {},
    };

    mockDocuments = [
      {
        id: 'doc1',
        title: 'Test Document 1',
        body: 'This is a test document with relevant content.',
        metadata: {
          source: 'test-source',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.8,
          url: null,
        },
      },
      {
        id: 'doc2',
        title: 'Test Document 2',
        body: 'This is another test document with relevant content.',
        metadata: {
          source: 'test-source',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.7,
          url: null,
        },
      },
    ];

    // Mock SearchService implementation
    (SearchService.fromEnv as jest.Mock).mockReturnValue({
      search: jest.fn().mockResolvedValue(mockDocuments),
    });

    // Mock ObservabilityService implementation
    (ObservabilityService.startSpan as jest.Mock).mockReturnValue('test-span-id');
    (ObservabilityService.endSpan as jest.Mock).mockImplementation(() => {});
    (ObservabilityService.logEvent as jest.Mock).mockImplementation(() => {});
  });

  test('should retrieve documents and attach them to state', async () => {
    // Execute the node
    const result = await retrieve(mockState, mockEnv);

    // Verify SearchService was called with correct parameters
    expect(SearchService.fromEnv).toHaveBeenCalledWith(mockEnv);
    expect(SearchService.fromEnv(mockEnv).search).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        query: 'enhanced test query',
      })
    );

    // Verify documents were added to state
    expect(result.docs).toBeDefined();
    expect(result.docs?.length).toBe(2);
    
    // Verify state transformation
    expect(result).toEqual(
      expect.objectContaining({
        userId: 'test-user-id',
        tasks: expect.objectContaining({
          originalQuery: 'test query',
          rewrittenQuery: 'enhanced test query',
        }),
        docs: expect.arrayContaining([
          expect.objectContaining({
            id: 'doc1',
            title: 'Test Document 1',
          }),
          expect.objectContaining({
            id: 'doc2',
            title: 'Test Document 2',
          }),
        ]),
      })
    );

    // Verify observability was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      mockEnv,
      'test-trace-id',
      'test-span-id',
      'retrieval_complete',
      expect.any(Object)
    );
  });

  test('should handle empty search results and set needsWidening', async () => {
    // Mock empty search results
    (SearchService.fromEnv as jest.Mock).mockReturnValue({
      search: jest.fn().mockResolvedValue([]),
    });

    // Execute the node
    const result = await retrieve(mockState, mockEnv);

    // Verify empty docs array
    expect(result.docs).toEqual([]);
    
    // Verify needsWidening flag is set
    expect(result.tasks?.needsWidening).toBe(true);

    // Verify observability event for empty results
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      mockEnv,
      'test-trace-id',
      'test-span-id',
      'retrieval_complete',
      expect.objectContaining({
        documentCount: 0,
        hasDocs: false,
      })
    );
  });

  test('should handle search service errors gracefully', async () => {
    // Mock search error
    const testError = new Error('Search service error');
    (SearchService.fromEnv as jest.Mock).mockReturnValue({
      search: jest.fn().mockRejectedValue(testError),
    });

    // Execute the node
    const result = await retrieve(mockState, mockEnv);

    // Verify empty docs array
    expect(result.docs).toEqual([]);
    
    // Verify error was logged
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      mockEnv,
      'test-trace-id',
      'test-span-id',
      'retrieval_error',
      expect.objectContaining({
        error: 'Search service error',
      })
    );

    // Verify error was added to metadata
    expect(result.metadata?.errors).toContainEqual(
      expect.objectContaining({
        node: 'retrieve',
        message: 'Search service error',
      })
    );
  });
});