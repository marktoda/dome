import { describe, it, expect, vi } from 'vitest';
import { docToSources } from './docToSources';
import { AgentState, Document } from '../types';

// Mock the logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

describe('docToSources Node', () => {
  it('should map docs to sources correctly', async () => {
    // Setup test data
    const mockDocs: Document[] = [
      {
        id: 'doc1',
        title: 'Document 1',
        body: 'This is document 1 content',
        metadata: {
          source: 'knowledge-base',
          createdAt: '2025-04-01',
          relevanceScore: 0.95,
          url: 'https://example.com/doc1',
          tokenCount: 100
        }
      },
      {
        id: 'doc2',
        title: 'Document 2',
        body: 'This is document 2 content',
        metadata: {
          source: 'web-search',
          createdAt: '2025-04-02',
          relevanceScore: 0.85,
          url: null,
          tokenCount: 80
        }
      }
    ];

    const initialState: Partial<AgentState> = {
      docs: mockDocs,
      metadata: {}
    };

    // Execute the node
    const result = await docToSources(initialState as AgentState);

    // Assert the expected outcome
    expect(result.sources).toBeDefined();
    expect(result.sources?.length).toBe(2);
    
    // Verify source mapping structure
    expect(result.sources?.[0]).toEqual({
      id: 'doc1',
      title: 'Document 1',
      source: 'knowledge-base',
      url: 'https://example.com/doc1',
      relevanceScore: 0.95
    });
    
    expect(result.sources?.[1]).toEqual({
      id: 'doc2',
      title: 'Document 2',
      source: 'web-search',
      url: null,
      relevanceScore: 0.85
    });

    // Verify metadata was updated
    expect(result.metadata?.currentNode).toBe('doc_to_sources');
    expect(result.metadata?.nodeTimings?.docToSources).toBeGreaterThan(0);
  });

  it('should handle empty docs array', async () => {
    // Setup test with empty docs
    const initialState: Partial<AgentState> = {
      docs: [],
      metadata: {}
    };

    // Execute the node
    const result = await docToSources(initialState as AgentState);

    // Assert empty sources array was returned
    expect(result.sources).toBeDefined();
    expect(result.sources?.length).toBe(0);
    expect(result.metadata?.currentNode).toBe('doc_to_sources');
  });

  it('should handle undefined docs', async () => {
    // Setup test with undefined docs
    const initialState: Partial<AgentState> = {
      metadata: {}
    };

    // Execute the node
    const result = await docToSources(initialState as AgentState);

    // Assert empty sources array was returned
    expect(result.sources).toBeDefined();
    expect(result.sources?.length).toBe(0);
    expect(result.metadata?.currentNode).toBe('doc_to_sources');
  });
});