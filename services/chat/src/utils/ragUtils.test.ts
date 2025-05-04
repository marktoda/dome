// @ts-nocheck
/// <reference types="vitest" />
import { vi } from 'vitest';
import { countTokens, scoreFilter, concatListFiles, reduceRagContext } from './ragUtils';
import { AgentState, Document } from '../types';

// Mock the baseCountTokens function from tokenCounter.ts
vi.mock('./tokenCounter', () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)), // Simple approximation for tests
}));

describe('countTokens', () => {
  it('should return 0 for empty text', () => {
    expect(countTokens('', 'gpt-4')).toBe(0);
    expect(countTokens('', 'claude-3-sonnet')).toBe(0);
  });

  it('should count tokens for different models', () => {
    const text = 'This is a test sentence for token counting.';

    // Different model IDs should yield reasonable token counts
    const gpt4Count = countTokens(text, 'gpt-4');
    const gpt35Count = countTokens(text, 'gpt-3.5-turbo');
    const claudeCount = countTokens(text, 'claude-3-sonnet-20240229');
    const llamaCount = countTokens(text, '@cf/meta/llama-3.1-8b-instruct-fp8-fast');

    // All counts should be > 0 and reasonable for this text
    expect(gpt4Count).toBeGreaterThan(0);
    expect(gpt35Count).toBeGreaterThan(0);
    expect(claudeCount).toBeGreaterThan(0);
    expect(llamaCount).toBeGreaterThan(0);
  });
});

describe('scoreFilter', () => {
  // Sample documents with different types of scores
  const docs: Document[] = [
    {
      id: 'doc1',
      title: 'Document 1',
      body: 'Content of document 1',
      metadata: {
        source: 'source1',
        createdAt: '2025-01-01',
        relevanceScore: 0.9,
      },
    },
    {
      id: 'doc2',
      title: 'Document 2',
      body: 'Content of document 2',
      metadata: {
        source: 'source2',
        createdAt: '2025-01-02',
        relevanceScore: 0.5,
      },
    },
    {
      id: 'doc3',
      title: 'Document 3',
      body: 'Content of document 3',
      metadata: {
        source: 'source3',
        createdAt: '2025-01-03',
        semantic_similarity: 0.7, // Using alternative score field
        relevanceScore: 0, // Should use the higher semantic_similarity
      },
    },
    {
      id: 'doc4',
      title: 'Document 4',
      body: 'Content of document 4',
      metadata: {
        source: 'source4',
        createdAt: '2025-01-04',
        confidence: 0.6, // Using another alternative score field
        relevanceScore: 0, // Should use confidence
      },
    },
    {
      id: 'doc5',
      title: 'Document 5',
      body: 'Content of document 5',
      metadata: {
        source: 'source5',
        createdAt: '2025-01-05',
        relevanceScore: 0.3,
      },
    },
  ];

  it('should return empty array for empty input', () => {
    expect(scoreFilter([], 0.5)).toEqual([]);
    expect(scoreFilter(null as any, 0.5)).toEqual([]);
  });

  it('should return all docs if threshold is 0 or negative', () => {
    expect(scoreFilter(docs, 0)).toEqual(docs);
    expect(scoreFilter(docs, -0.1)).toEqual(docs);
  });

  it('should filter docs based on relevanceScore threshold', () => {
    const filtered = scoreFilter(docs, 0.6);
    expect(filtered).toHaveLength(3);
    expect(filtered.map(d => d.id)).toContain('doc1');
    expect(filtered.map(d => d.id)).toContain('doc3');
    expect(filtered.map(d => d.id)).toContain('doc4');
  });

  it('should consider alternative score fields', () => {
    const filtered = scoreFilter(docs, 0.7);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(d => d.id)).toContain('doc1');
    expect(filtered.map(d => d.id)).toContain('doc3');
  });
});

describe('concatListFiles', () => {
  it('should return empty string for empty input', () => {
    expect(concatListFiles([], 100)).toBe('');
    expect(concatListFiles(null as any, 100)).toBe('');
  });

  it('should format file list within max length', () => {
    const files = ['file1.txt', 'file2.txt', 'file3.txt'];
    const result = concatListFiles(files, 100);

    expect(result).toContain('Files:');
    expect(result).toContain('- file1.txt');
    expect(result).toContain('- file2.txt');
    expect(result).toContain('- file3.txt');
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('should truncate file list that exceeds max length', () => {
    const files = [
      'very_long_filename1.txt',
      'very_long_filename2.txt',
      'very_long_filename3.txt',
      'very_long_filename4.txt',
      'very_long_filename5.txt',
    ];

    // Set a small max length to force truncation
    const result = concatListFiles(files, 50);

    expect(result).toContain('Files:');
    expect(result).toContain('more files');
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe('reduceRagContext', () => {
  // Mock documents with token counts
  const mockDocs: Document[] = [
    {
      id: 'doc1',
      title: 'High relevance doc',
      body: 'This is a highly relevant document',
      metadata: {
        source: 'source1',
        createdAt: '2025-01-01',
        relevanceScore: 0.9,
        tokenCount: 20,
      },
    },
    {
      id: 'doc2',
      title: 'Medium relevance doc',
      body: 'This is a somewhat relevant document',
      metadata: {
        source: 'source2',
        createdAt: '2025-01-02',
        relevanceScore: 0.7,
        tokenCount: 25,
      },
    },
    {
      id: 'doc3',
      title: 'Low relevance doc',
      body: 'This is a less relevant document',
      metadata: {
        source: 'source3',
        createdAt: '2025-01-03',
        relevanceScore: 0.5,
        tokenCount: 18,
      },
    },
    {
      id: 'doc4',
      title: 'Semantic similarity doc',
      body: 'This document uses semantic similarity',
      metadata: {
        source: 'source4',
        createdAt: '2025-01-04',
        relevanceScore: 0,
        semantic_similarity: 0.8,
        tokenCount: 22,
      },
    },
  ];

  // Mock agent state
  const mockState: AgentState = {
    userId: 'user123',
    messages: [],
    options: {
      enhanceWithContext: true,
      maxContextItems: 5,
      includeSourceInfo: true,
      maxTokens: 1000,
      modelId: 'gpt-4',
    },
    docs: mockDocs,
    metadata: {},
    tasks: {}, // Required property
  };

  it('should return empty array when no docs are provided', () => {
    const emptyState: AgentState = { ...mockState, docs: [] };
    const result = reduceRagContext(emptyState, 100);

    expect(result.docs).toEqual([]);
    expect(result.tokenCount).toBe(0);
  });

  it('should sort and include docs within token limit', () => {
    // Set token limit to fit only 2 docs
    const result = reduceRagContext(mockState, 45);

    expect(result.docs).toHaveLength(2);
    expect(result.docs[0].id).toBe('doc1'); // Highest relevance
    expect(result.docs[1].id).toBe('doc4'); // Second highest using semantic_similarity
    expect(result.tokenCount).toBe(42); // 20 + 22
  });

  it('should include at least one document even if it exceeds the token limit', () => {
    // Set token limit lower than a single doc's token count
    const result = reduceRagContext(mockState, 15);

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].id).toBe('doc1'); // Most relevant doc
    expect(result.tokenCount).toBe(20); // Still include the doc even though it's over limit
  });

  it('should handle documents without pre-calculated token counts', () => {
    // Create docs without token counts
    const docsWithoutTokenCounts = mockDocs.map(doc => ({
      ...doc,
      metadata: { ...doc.metadata, tokenCount: undefined },
    }));

    const stateWithoutTokenCounts: AgentState = {
      ...mockState,
      docs: docsWithoutTokenCounts,
    };

    const result = reduceRagContext(stateWithoutTokenCounts, 100);

    // Should still return results and calculate token counts on the fly
    expect(result.docs.length).toBeGreaterThan(0);
    expect(result.tokenCount).toBeGreaterThan(0);

    // Should have added token counts to the docs
    expect(result.docs[0].metadata.tokenCount).toBeDefined();
  });
});
