import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    })
  }),
  logError: vi.fn(),
  countTokens: vi.fn().mockReturnValue(100),
  chooseModel: vi.fn().mockReturnValue({ id: 'gpt-4-turbo' }),
  allocateContext: vi.fn().mockReturnValue({
    maxContextTokens: 8192,
    maxResponseTokens: 1000
  })
}));

vi.mock('@dome/common/errors', () => ({
  toDomeError: vi.fn().mockImplementation((err) => err)
}));

vi.mock('../src/services/observabilityService', () => ({
  ObservabilityService: {
    startSpan: vi.fn().mockReturnValue('mock-span-id'),
    endSpan: vi.fn(),
    recordMetrics: vi.fn()
  }
}));

vi.mock('../src/utils/promptHelpers', () => ({
  formatDocsForPrompt: vi.fn().mockReturnValue('Formatted docs content')
}));

vi.mock('../src/utils', () => ({
  buildMessages: vi.fn().mockReturnValue([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Test question' }
  ])
}));

vi.mock('../src/config/promptsConfig', () => ({
  getGenerateAnswerPrompt: vi.fn().mockReturnValue('Generate a comprehensive answer based on the context.')
}));

// Mock LLM service
const mockLlmService = {
  generateResponse: vi.fn().mockResolvedValue('Generated answer based on context'),
  generateStructuredResponse: vi.fn().mockResolvedValue({
    answer: 'Structured answer',
    confidence: 0.9
  })
};

vi.mock('../src/services/llmService', () => ({
  LlmService: vi.fn().mockImplementation(() => mockLlmService)
}));

// Import after mocking
import { generateAnswer } from '../src/nodes/generateAnswer';
import type { AgentStateV3 as AgentState } from '../src/types/stateSlices';

describe('generateAnswer node', () => {
  let mockState: AgentState;
  let mockConfig: any;
  let mockEnv: any;

  beforeEach(() => {
    mockState = {
      userId: 'test-user',
      messages: [
        { role: 'user', content: 'What is the weather today?', timestamp: Date.now() }
      ],
      chatHistory: [],
      docs: [
        {
          id: 'doc-1',
          content: 'Weather information: It is sunny today with temperature of 25°C.',
          metadata: {
            source: 'weather-api',
            sourceType: 'web',
            relevanceScore: 0.9
          }
        }
      ],
      generatedText: '',
      taskIds: [],
      taskEntities: {},
      retrievalLoop: {
        attempt: 1,
        issuedQueries: ['weather today'],
        refinedQueries: [],
        seenChunkIds: []
      },
      metadata: {
        startTime: performance.now(),
        traceId: 'test-trace-id'
      }
    } as AgentState;

    mockConfig = {
      configurable: {
        thread_id: 'test-thread',
        runId: 'test-run'
      }
    };

    mockEnv = {
      AI_MODEL_NAME: 'gpt-4-turbo',
      AI_TOKEN_LIMIT: '1000'
    };

    // Reset mocks
    vi.clearAllMocks();
  });

  describe('basic functionality', () => {
    it('should generate an answer based on provided context', async () => {
      const result = await generateAnswer(mockState, mockConfig, mockEnv);

      expect(result).toBeDefined();
      expect(result.generatedText).toBeDefined();
      expect(mockLlmService.generateResponse).toHaveBeenCalled();
    });

    it('should handle empty document context', async () => {
      const stateWithoutDocs = {
        ...mockState,
        docs: []
      };

      const result = await generateAnswer(stateWithoutDocs, mockConfig, mockEnv);

      expect(result).toBeDefined();
      // Should still generate a response even without docs
      expect(mockLlmService.generateResponse).toHaveBeenCalled();
    });

    it('should use the correct prompt configuration', async () => {
      await generateAnswer(mockState, mockConfig, mockEnv);

      const { getGenerateAnswerPrompt } = await import('../src/config/promptsConfig');
      expect(getGenerateAnswerPrompt).toHaveBeenCalled();
    });
  });

  describe('context handling', () => {
    it('should format documents for prompt correctly', async () => {
      await generateAnswer(mockState, mockConfig, mockEnv);

      const { formatDocsForPrompt } = await import('../src/utils/promptHelpers');
      expect(formatDocsForPrompt).toHaveBeenCalledWith(mockState.docs);
    });

    it('should handle multiple documents', async () => {
      const stateWithMultipleDocs = {
        ...mockState,
        docs: [
          {
            id: 'doc-1',
            content: 'First document content',
            metadata: { source: 'source1', relevanceScore: 0.9 }
          },
          {
            id: 'doc-2', 
            content: 'Second document content',
            metadata: { source: 'source2', relevanceScore: 0.8 }
          }
        ]
      };

      const result = await generateAnswer(stateWithMultipleDocs, mockConfig, mockEnv);

      expect(result).toBeDefined();
      expect(mockLlmService.generateResponse).toHaveBeenCalled();
    });
  });

  describe('observability and tracing', () => {
    it('should start and track spans for observability', async () => {
      await generateAnswer(mockState, mockConfig, mockEnv);

      const { ObservabilityService } = await import('../src/services/observabilityService');
      expect(ObservabilityService.startSpan).toHaveBeenCalledWith(
        mockEnv,
        'test-trace-id',
        'generateAnswer',
        mockState
      );
    });

    it('should handle missing trace ID by generating one', async () => {
      const stateWithoutTraceId = {
        ...mockState,
        metadata: {
          startTime: performance.now()
          // no traceId
        }
      };

      await generateAnswer(stateWithoutTraceId, mockConfig, mockEnv);

      const { ObservabilityService } = await import('../src/services/observabilityService');
      expect(ObservabilityService.startSpan).toHaveBeenCalled();
      // Should generate a traceId if not present
      const callArgs = (ObservabilityService.startSpan as any).mock.calls[0];
      expect(typeof callArgs[1]).toBe('string'); // traceId should be string
    });
  });

  describe('message building', () => {
    it('should build messages correctly for LLM', async () => {
      await generateAnswer(mockState, mockConfig, mockEnv);

      const { buildMessages } = await import('../src/utils');
      expect(buildMessages).toHaveBeenCalled();
    });

    it('should handle user messages correctly', async () => {
      const stateWithMultipleMessages = {
        ...mockState,
        messages: [
          { role: 'user', content: 'First question', timestamp: Date.now() },
          { role: 'assistant', content: 'First answer', timestamp: Date.now() + 1000 },
          { role: 'user', content: 'Follow up question', timestamp: Date.now() + 2000 }
        ]
      };

      const result = await generateAnswer(stateWithMultipleMessages, mockConfig, mockEnv);

      expect(result).toBeDefined();
      expect(mockLlmService.generateResponse).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle LLM service errors gracefully', async () => {
      mockLlmService.generateResponse.mockRejectedValueOnce(new Error('LLM error'));

      await expect(generateAnswer(mockState, mockConfig, mockEnv))
        .rejects.toThrow('LLM error');
    });

    it('should handle malformed state gracefully', async () => {
      const malformedState = {
        ...mockState,
        messages: null // Invalid messages
      } as any;

      await expect(generateAnswer(malformedState, mockConfig, mockEnv))
        .rejects.toBeDefined();
    });
  });

  describe('performance and metrics', () => {
    it('should measure execution time', async () => {
      const startTime = performance.now();
      await generateAnswer(mockState, mockConfig, mockEnv);
      const endTime = performance.now();

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(5000); // 5 seconds max for test
    });

    it('should log performance metrics', async () => {
      await generateAnswer(mockState, mockConfig, mockEnv);

      // Logger should be called for performance tracking
      expect(vi.mocked(require('@dome/common').getLogger)().child).toHaveBeenCalled();
    });
  });
});