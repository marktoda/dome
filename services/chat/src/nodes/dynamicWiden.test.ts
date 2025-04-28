import { vi, describe, test, expect, beforeEach } from 'vitest';
import { dynamicWiden, WideningStrategy } from './dynamicWiden';
import { AgentState, Document } from '../types';
import { getLogger } from '@dome/logging';
import { ObservabilityService } from '../services/observabilityService';

// Mock dependencies
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../services/observabilityService', () => ({
  ObservabilityService: {
    startSpan: vi.fn().mockReturnValue('test-span-id'),
    endSpan: vi.fn(),
    logEvent: vi.fn(),
  },
}));

describe('dynamicWiden node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockDocuments: Document[];

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup performance.now mock
    global.performance = {
      now: vi.fn()
        .mockReturnValueOnce(1000) // First call (start time)
        .mockReturnValueOnce(1500), // Second call (end time)
      // Add other performance methods if needed
    } as any;

    // Setup test data
    mockDocuments = [
      {
        id: 'doc1',
        title: 'Test Document 1',
        body: 'This is a test document with relevant content.',
        metadata: {
          source: 'test-source',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.6,
          url: null,
        },
      },
    ];

    // Setup test state
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
        wideningAttempts: 0,
      },
      docs: mockDocuments,
      metadata: {
        traceId: 'test-trace-id',
        startTime: Date.now(),
      },
    };

    mockEnv = {};
  });

  test('should increment widening attempts and apply a widening strategy', async () => {
    // Execute the node
    const result = await dynamicWiden(mockState, mockEnv);

    // Verify widening attempts were incremented
    expect(result.tasks?.wideningAttempts).toBe(1);
    
    // Verify widening strategy was set
    expect(result.tasks?.wideningStrategy).toBeDefined();
    
    // Verify widening params are set
    expect(result.tasks?.wideningParams).toBeDefined();
    expect(result.tasks?.wideningParams?.strategy).toBeDefined();
    
    // Verify observability was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      mockEnv,
      'test-trace-id',
      'test-span-id',
      'widening_parameters_adjusted',
      expect.any(Object)
    );
    
    // Verify timing information was added
    expect(result.metadata?.nodeTimings?.dynamicWiden).toBe(500); // 1500 - 1000
  });
  
  test('should apply relevance strategy when no documents are found', async () => {
    // Setup state with no documents
    mockState.docs = [];
    
    // Execute the node
    const result = await dynamicWiden(mockState, mockEnv);
    
    // Verify relevance strategy was selected
    expect(result.tasks?.wideningStrategy).toBe(WideningStrategy.RELEVANCE);
    
    // Verify minimum relevance was lowered
    expect(result.tasks?.wideningParams?.minRelevance).toBeLessThan(0.5);
  });
  
  test('should apply semantic strategy for low relevance documents', async () => {
    // Setup state with low relevance documents
    mockState.docs = [{
      id: 'doc1',
      title: 'Low Relevance Document',
      body: 'This document has low relevance.',
      metadata: {
        source: 'test-source',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.3, // Low relevance
        url: null,
      },
    }];
    
    // Execute the node
    const result = await dynamicWiden(mockState, mockEnv);
    
    // Verify semantic strategy was selected for low relevance
    expect(result.tasks?.wideningStrategy).toBe(WideningStrategy.SEMANTIC);
    
    // Verify expand synonyms was enabled
    expect(result.tasks?.wideningParams?.expandSynonyms).toBe(true);
  });
  
  test('should respect maximum widening attempts limit', async () => {
    // Setup state with max attempts
    mockState.tasks!.wideningAttempts = 3;
    
    // Execute the node
    const result = await dynamicWiden(mockState, mockEnv);
    
    // Verify widening attempts are incremented but strategy indicates maximum reached
    expect(result.tasks?.wideningAttempts).toBe(4);
    expect(result.tasks?.wideningStrategy).toBe(WideningStrategy.HYBRID);
    expect(result.tasks?.needsWidening).toBe(false);
  });
  
  test('should handle errors gracefully', async () => {
    // Force an error
    vi.spyOn(global.Math, 'random').mockImplementation(() => {
      throw new Error('Test error');
    });
    
    // Execute the node
    const result = await dynamicWiden(mockState, mockEnv);
    
    // Verify error was handled
    expect(result.tasks?.wideningAttempts).toBe(1);
    expect(result.tasks?.wideningStrategy).toBe(WideningStrategy.RELEVANCE);
    
    // Verify error was added to metadata
    expect(result.metadata?.errors).toContainEqual(
      expect.objectContaining({
        node: 'dynamicWiden',
        message: 'Test error',
      })
    );
    
    // Verify error was logged
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      mockEnv,
      'test-trace-id',
      'test-span-id',
      'widening_error',
      expect.objectContaining({
        error: 'Test error',
      })
    );
  });
});