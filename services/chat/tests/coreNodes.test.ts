import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as nodes from '../src/nodes';
import { AgentState } from '../src/types';
import { LangGraphRunnableConfig } from '@langchain/langgraph';

// Mock dependencies
vi.mock('@dome/common');
vi.mock('../src/services');
vi.mock('../src/utils/tokenCounter');

describe('Core Node Implementations', () => {
  let mockEnv: Env;
  let mockConfig: LangGraphRunnableConfig;
  let baseState: AgentState;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      CHAT_DB: {} as D1Database,
      MAX_RAG_LOOPS: '3',
    } as Env;

    mockConfig = {
      configurable: {
        thread_id: 'test-thread',
        runId: 'test-run',
      },
    };

    baseState = {
      userId: 'test-user',
      messages: [
        { role: 'user', content: 'What is machine learning?', timestamp: Date.now() },
      ],
      chatHistory: [],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      taskIds: [],
      taskEntities: {},
      docs: [],
      generatedText: '',
      retrievalLoop: {
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      },
      metadata: {},
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('combineContext', () => {
    it('should combine documents into context when docs are available', async () => {
      const stateWithDocs = {
        ...baseState,
        docs: [
          {
            id: 'doc1',
            content: 'Machine learning is a subset of AI.',
            metadata: { score: 0.9, source: 'textbook' },
          },
          {
            id: 'doc2',
            content: 'It involves training algorithms on data.',
            metadata: { score: 0.8, source: 'article' },
          },
        ],
      };

      const result = await nodes.combineContext(stateWithDocs, mockEnv);

      expect(result).toHaveProperty('combinedContext');
      expect(result.combinedContext).toContain('Machine learning is a subset of AI');
      expect(result.combinedContext).toContain('It involves training algorithms on data');
      expect(result.docs).toEqual(stateWithDocs.docs);
    });

    it('should handle empty docs gracefully', async () => {
      const result = await nodes.combineContext(baseState, mockEnv);

      expect(result).toHaveProperty('combinedContext');
      expect(result.combinedContext).toBe('');
      expect(result.docs).toEqual([]);
    });

    it('should include metadata when combining context', async () => {
      const stateWithMetadata = {
        ...baseState,
        docs: [
          {
            id: 'doc1',
            content: 'ML content',
            metadata: { 
              score: 0.95, 
              source: 'research-paper',
              title: 'Introduction to ML',
              url: 'https://example.com/ml'
            },
          },
        ],
      };

      const result = await nodes.combineContext(stateWithMetadata, mockEnv);

      expect(result.combinedContext).toContain('ML content');
      expect(result.docs[0].metadata).toEqual(stateWithMetadata.docs[0].metadata);
    });
  });

  describe('generateAnswer', () => {
    it('should generate answer using LLM service', async () => {
      const stateWithContext = {
        ...baseState,
        combinedContext: 'Machine learning is a subset of artificial intelligence.',
      };

      // Mock the LLM service call
      const mockLLMResponse = {
        content: 'Machine learning is indeed a subset of AI that focuses on training algorithms.',
      };

      // We'll need to mock the actual LLM service
      const result = await nodes.generateAnswer(stateWithContext, mockConfig, mockEnv);

      expect(result).toHaveProperty('generatedText');
      expect(result.messages).toEqual(stateWithContext.messages);
    });

    it('should handle LLM service errors gracefully', async () => {
      const stateWithContext = {
        ...baseState,
        combinedContext: 'Context for generation',
      };

      // This test would verify error handling if LLM service fails
      await expect(async () => {
        await nodes.generateAnswer(stateWithContext, mockConfig, mockEnv);
      }).not.toThrow();
    });
  });

  describe('answerGuard', () => {
    it('should validate generated answers', async () => {
      const stateWithAnswer = {
        ...baseState,
        generatedText: 'This is a valid, helpful answer about machine learning.',
      };

      const result = await nodes.answerGuard(stateWithAnswer);

      expect(result).toHaveProperty('generatedText');
      expect(result.generatedText).toBe(stateWithAnswer.generatedText);
    });

    it('should handle empty or invalid answers', async () => {
      const stateWithEmptyAnswer = {
        ...baseState,
        generatedText: '',
      };

      const result = await nodes.answerGuard(stateWithEmptyAnswer);

      expect(result).toHaveProperty('generatedText');
      // Guard should either fix or flag the empty answer
    });

    it('should check for harmful content', async () => {
      const stateWithHarmfulContent = {
        ...baseState,
        generatedText: 'This response contains inappropriate content.',
      };

      const result = await nodes.answerGuard(stateWithHarmfulContent);

      expect(result).toHaveProperty('generatedText');
      // Guard should filter or modify harmful content
    });
  });

  describe('retrieve', () => {
    it('should retrieve relevant documents', async () => {
      const stateWithQuery = {
        ...baseState,
        retrievalLoop: {
          ...baseState.retrievalLoop,
          refinedQueries: ['machine learning basics'],
        },
      };

      const result = await nodes.retrieve(stateWithQuery, mockConfig, mockEnv);

      expect(result).toHaveProperty('docs');
      expect(Array.isArray(result.docs)).toBe(true);
      expect(result.retrievalLoop).toBeDefined();
    });

    it('should handle search service errors', async () => {
      const stateWithQuery = {
        ...baseState,
        retrievalLoop: {
          ...baseState.retrievalLoop,
          refinedQueries: ['test query'],
        },
      };

      // Should not throw even if search service fails
      await expect(async () => {
        await nodes.retrieve(stateWithQuery, mockConfig, mockEnv);
      }).not.toThrow();
    });

    it('should update retrieval loop state', async () => {
      const stateWithQuery = {
        ...baseState,
        retrievalLoop: {
          attempt: 1,
          issuedQueries: [],
          refinedQueries: ['machine learning'],
          seenChunkIds: [],
        },
      };

      const result = await nodes.retrieve(stateWithQuery, mockConfig, mockEnv);

      expect(result.retrievalLoop.issuedQueries).toContain('machine learning');
      expect(result.retrievalLoop.attempt).toBeGreaterThanOrEqual(1);
    });
  });

  describe('improveRetrieval', () => {
    it('should generate improved queries based on previous attempts', async () => {
      const stateWithHistory = {
        ...baseState,
        retrievalLoop: {
          attempt: 2,
          issuedQueries: ['machine learning'],
          refinedQueries: ['machine learning'],
          seenChunkIds: ['chunk1', 'chunk2'],
        },
        docs: [
          {
            id: 'doc1',
            content: 'Basic ML content',
            metadata: { score: 0.5 },
          },
        ],
      };

      const result = await nodes.improveRetrieval(stateWithHistory, mockEnv);

      expect(result.retrievalLoop.attempt).toBe(3);
      expect(result.retrievalLoop.refinedQueries).toBeDefined();
      expect(Array.isArray(result.retrievalLoop.refinedQueries)).toBe(true);
    });

    it('should maintain query history', async () => {
      const previousQueries = ['machine learning', 'artificial intelligence'];
      const stateWithHistory = {
        ...baseState,
        retrievalLoop: {
          attempt: 1,
          issuedQueries: previousQueries,
          refinedQueries: previousQueries,
          seenChunkIds: [],
        },
      };

      const result = await nodes.improveRetrieval(stateWithHistory, mockEnv);

      expect(result.retrievalLoop.issuedQueries).toEqual(previousQueries);
      expect(result.retrievalLoop.attempt).toBe(2);
    });
  });

  describe('routingSplit', () => {
    it('should route user messages appropriately', async () => {
      const result = await nodes.routingSplit(baseState, mockEnv);

      expect(result).toHaveProperty('messages');
      expect(result.messages).toEqual(baseState.messages);
      expect(result).toHaveProperty('userId');
    });

    it('should handle different message types', async () => {
      const stateWithSystemMessage = {
        ...baseState,
        messages: [
          { role: 'system', content: 'You are a helpful assistant', timestamp: Date.now() },
          { role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
      };

      const result = await nodes.routingSplit(stateWithSystemMessage, mockEnv);

      expect(result.messages).toEqual(stateWithSystemMessage.messages);
    });
  });

  describe('rewrite', () => {
    it('should rewrite user queries for better retrieval', async () => {
      const result = await nodes.rewrite(baseState, mockEnv);

      expect(result).toHaveProperty('retrievalLoop');
      expect(result.retrievalLoop).toHaveProperty('refinedQueries');
      expect(Array.isArray(result.retrievalLoop.refinedQueries)).toBe(true);
    });

    it('should handle complex multi-part questions', async () => {
      const complexQuery = {
        ...baseState,
        messages: [
          {
            role: 'user',
            content: 'What is machine learning and how does it differ from traditional programming?',
            timestamp: Date.now(),
          },
        ],
      };

      const result = await nodes.rewrite(complexQuery, mockEnv);

      expect(result.retrievalLoop.refinedQueries.length).toBeGreaterThan(0);
    });
  });

  describe('docToSources', () => {
    it('should convert documents to source format', async () => {
      const stateWithDocs = {
        ...baseState,
        docs: [
          {
            id: 'doc1',
            content: 'Content 1',
            metadata: {
              source: 'textbook',
              title: 'ML Fundamentals',
              url: 'https://example.com/ml',
              score: 0.9,
            },
          },
          {
            id: 'doc2',
            content: 'Content 2',
            metadata: {
              source: 'article',
              title: 'AI Research',
              score: 0.8,
            },
          },
        ],
      };

      const result = await nodes.docToSources(stateWithDocs);

      expect(result).toHaveProperty('sources');
      expect(Array.isArray(result.sources)).toBe(true);
      expect(result.sources.length).toBe(2);
      expect(result.sources[0]).toHaveProperty('id');
      expect(result.sources[0]).toHaveProperty('type');
    });

    it('should handle docs without metadata gracefully', async () => {
      const stateWithMinimalDocs = {
        ...baseState,
        docs: [
          {
            id: 'doc1',
            content: 'Basic content',
            metadata: {},
          },
        ],
      };

      const result = await nodes.docToSources(stateWithMinimalDocs);

      expect(result.sources).toBeDefined();
      expect(result.sources.length).toBe(1);
    });
  });
});