import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateAnswer, GenerateAnswerUpdate } from '../src/nodes/generateAnswer';
import { AgentStateV3 as AgentState } from '../src/types/stateSlices';
import { LangGraphRunnableConfig } from '@langchain/langgraph';

// Mock all external dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  logError: vi.fn(),
  countTokens: vi.fn((text: string) => text.length / 4), // Rough approximation
  chooseModel: vi.fn(() => ({
    id: 'gpt-4-turbo',
    maxContextTokens: 8192,
  })),
  allocateContext: vi.fn(() => ({
    maxResponse: 1000,
  })),
}));

vi.mock('@dome/common/errors', () => ({
  toDomeError: (err: any) => ({
    message: err.message || 'Unknown error',
    code: 'UNKNOWN_ERROR',
  }),
}));

vi.mock('../src/services/llmService', () => ({
  LlmService: {
    call: vi.fn().mockResolvedValue('Generated answer response'),
    stream: vi.fn().mockImplementation(async function* () {
      yield 'Generated ';
      yield 'answer ';
      yield 'response ';
      yield 'from stream';
    }),
  },
}));

vi.mock('../src/services/observabilityService', () => ({
  ObservabilityService: {
    startSpan: vi.fn(() => 'test-span-id'),
    endSpan: vi.fn(),
    logEvent: vi.fn(),
  },
}));

vi.mock('../src/utils/promptHelpers', () => ({
  formatDocsForPrompt: vi.fn((docs) => 
    docs.map((doc: any) => `Document: ${doc.content}`).join('\n')
  ),
}));

vi.mock('../src/utils', () => ({
  buildMessages: vi.fn((systemPrompt, chatHistory, userQuery) => [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userQuery },
  ]),
}));

vi.mock('../src/config/promptsConfig', () => ({
  getGenerateAnswerPrompt: vi.fn((userQuery, docContext) => 
    `System: Generate a comprehensive answer based on the following context:\n${docContext}\n\nUser Query: ${userQuery}`
  ),
}));

// Mock crypto.randomUUID
global.crypto = {
  randomUUID: vi.fn(() => 'test-uuid-123'),
} as any;

// Mock performance.now
global.performance = {
  now: vi.fn(() => 1000),
} as any;

describe('generateAnswer', () => {
  let mockState: AgentState;
  let mockConfig: LangGraphRunnableConfig;
  let mockEnv: Env;

  const createMockState = (overrides: Partial<AgentState> = {}): AgentState => ({
    userId: 'test-user',
    messages: [
      { role: 'user', content: 'What is artificial intelligence?' },
    ],
    chatHistory: [],
    docs: [
      {
        content: 'Artificial intelligence is a field of computer science...',
        metadata: { source: 'doc1.pdf', title: 'AI Introduction' },
        id: 'doc1',
        score: 0.9,
      },
      {
        content: 'Machine learning is a subset of AI...',
        metadata: { source: 'doc2.pdf', title: 'ML Basics' },
        id: 'doc2',
        score: 0.8,
      },
    ],
    options: {
      enhanceWithContext: true,
      maxContextItems: 5,
      includeSourceInfo: true,
      maxTokens: 1000,
      temperature: 0.3,
    },
    metadata: {
      traceId: 'existing-trace-id',
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockState = createMockState();
    mockConfig = {
      configurable: {},
    };
    mockEnv = {
      OPENAI_API_KEY: 'test-key',
    } as Env;

    // Reset performance.now mock
    vi.mocked(performance.now).mockReturnValue(1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful answer generation', () => {
    it('should generate answer using LLM service', async () => {
      const result = await generateAnswer(mockState, mockConfig, mockEnv);

      expect(result.generatedText).toBe('Generated answer response');
      expect(result.metadata?.currentNode).toBe('generateAnswer');
      expect(result.metadata?.isFinalState).toBe(true);
    });

    it('should handle streaming mode', async () => {
      const mockHandleChunk = vi.fn();
      const streamConfig: LangGraphRunnableConfig = {
        configurable: {
          stream: {
            handleChunk: mockHandleChunk,
          },
        },
      };

      const result = await generateAnswer(mockState, streamConfig, mockEnv);

      expect(result.generatedText).toBe('Generated answer response from stream');
      expect(mockHandleChunk).toHaveBeenCalledTimes(4); // Four chunks
      expect(mockHandleChunk).toHaveBeenCalledWith({
        event: 'on_chat_model_stream',
        data: { chunk: 'Generated ' },
        metadata: { 
          langgraph_node: 'generateAnswer', 
          traceId: 'existing-trace-id', 
          spanId: 'test-span-id' 
        },
      });
    });

    it('should use correct model configuration', async () => {
      const { chooseModel, allocateContext } = require('@dome/common');
      const { LlmService } = require('../src/services/llmService');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(chooseModel).toHaveBeenCalledWith({ 
        task: 'generation', 
        explicitId: mockState.options?.modelId 
      });
      expect(allocateContext).toHaveBeenCalled();
      expect(LlmService.call).toHaveBeenCalledWith(
        mockEnv,
        expect.any(Array),
        {
          modelId: 'gpt-4-turbo',
          temperature: 0.3,
          maxTokens: 1000,
        }
      );
    });

    it('should format documents correctly', async () => {
      const { formatDocsForPrompt } = require('../src/utils/promptHelpers');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(formatDocsForPrompt).toHaveBeenCalledWith(mockState.docs);
    });

    it('should build system prompt with context', async () => {
      const { getGenerateAnswerPrompt } = require('../src/config/promptsConfig');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(getGenerateAnswerPrompt).toHaveBeenCalledWith(
        'What is artificial intelligence?',
        'Document: Artificial intelligence is a field of computer science...\nDocument: Machine learning is a subset of AI...'
      );
    });

    it('should calculate token usage correctly', async () => {
      const { countTokens } = require('@dome/common');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(countTokens).toHaveBeenCalledWith('What is artificial intelligence?');
      expect(countTokens).toHaveBeenCalledWith(
        'Document: Artificial intelligence is a field of computer science...\nDocument: Machine learning is a subset of AI...'
      );
    });

    it('should track observability metrics', async () => {
      const { ObservabilityService } = require('../src/services/observabilityService');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(ObservabilityService.startSpan).toHaveBeenCalledWith(
        mockEnv,
        'existing-trace-id',
        'generateAnswer',
        mockState
      );
      expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
        mockEnv,
        'existing-trace-id',
        'test-span-id',
        'context_stats',
        expect.objectContaining({
          contextTokens: expect.any(Number),
          userQueryTokens: expect.any(Number),
          maxResponseTokens: expect.any(Number),
        })
      );
      expect(ObservabilityService.endSpan).toHaveBeenCalled();
    });

    it('should include execution timing in metadata', async () => {
      vi.mocked(performance.now)
        .mockReturnValueOnce(1000) // Start time
        .mockReturnValueOnce(1500); // End time

      const result = await generateAnswer(mockState, mockConfig, mockEnv);

      expect(result.metadata?.executionTimeMs).toBe(500);
      expect(result.metadata?.nodeTimings?.generateAnswer).toBe(500);
    });

    it('should generate trace ID if not provided', async () => {
      const stateWithoutTrace = createMockState({ metadata: {} });

      await generateAnswer(stateWithoutTrace, mockConfig, mockEnv);

      expect(crypto.randomUUID).toHaveBeenCalled();
    });
  });

  describe('edge cases and validation', () => {
    it('should handle custom model ID from options', async () => {
      const { chooseModel } = require('@dome/common');
      const stateWithCustomModel = createMockState({
        options: {
          ...mockState.options,
          modelId: 'gpt-4o',
        },
      });

      await generateAnswer(stateWithCustomModel, mockConfig, mockEnv);

      expect(chooseModel).toHaveBeenCalledWith({ 
        task: 'generation', 
        explicitId: 'gpt-4o' 
      });
    });

    it('should throw error when no documents provided', async () => {
      const stateWithoutDocs = createMockState({ docs: undefined });

      const result = await generateAnswer(stateWithoutDocs, mockConfig, mockEnv);

      expect(result.generatedText).toBe(
        'I apologize, but I encountered an issue while generating an answer to your query. ' +
        'The system team has been notified of this error.'
      );
      expect(result.metadata?.errors).toHaveLength(1);
      expect(result.metadata?.errors?.[0].node).toBe('generateAnswer');
    });

    it('should handle empty documents array', async () => {
      const stateWithEmptyDocs = createMockState({ docs: [] });

      await generateAnswer(stateWithEmptyDocs, mockConfig, mockEnv);

      expect(require('../src/utils/promptHelpers').formatDocsForPrompt).toHaveBeenCalledWith([]);
    });

    it('should handle missing user query', async () => {
      const stateWithoutMessages = createMockState({ messages: [] });

      // This should throw an error when trying to access the last message
      const result = await generateAnswer(stateWithoutMessages, mockConfig, mockEnv);

      expect(result.generatedText).toContain('I apologize, but I encountered an issue');
      expect(result.metadata?.errors).toHaveLength(1);
    });

    it('should use default temperature when not provided', async () => {
      const stateWithoutTemp = createMockState({
        options: {
          ...mockState.options,
          temperature: undefined,
        },
      });

      await generateAnswer(stateWithoutTemp, mockConfig, mockEnv);

      expect(require('../src/services/llmService').LlmService.call).toHaveBeenCalledWith(
        mockEnv,
        expect.any(Array),
        expect.objectContaining({
          temperature: 0.3, // Default value
        })
      );
    });
  });

  describe('error handling', () => {
    it('should handle LLM service errors gracefully', async () => {
      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockRejectedValueOnce(new Error('LLM service unavailable'));

      const result = await generateAnswer(mockState, mockConfig, mockEnv);

      expect(result.generatedText).toBe(
        'I apologize, but I encountered an issue while generating an answer to your query. ' +
        'The system team has been notified of this error.'
      );
      expect(result.metadata?.errors).toHaveLength(1);
      expect(result.metadata?.errors?.[0].message).toBe('LLM service unavailable');
    });

    it('should handle streaming errors gracefully', async () => {
      const { LlmService } = require('../src/services/llmService');
      LlmService.stream.mockImplementationOnce(async function* () {
        throw new Error('Streaming failed');
      });

      const streamConfig: LangGraphRunnableConfig = {
        configurable: {
          stream: { handleChunk: vi.fn() },
        },
      };

      const result = await generateAnswer(mockState, streamConfig, mockEnv);

      expect(result.generatedText).toContain('I apologize, but I encountered an issue');
      expect(result.metadata?.errors).toHaveLength(1);
    });

    it('should preserve existing errors in metadata', async () => {
      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockRejectedValueOnce(new Error('New error'));

      const stateWithExistingErrors = createMockState({
        metadata: {
          errors: [{ node: 'retrieve', message: 'Previous error', timestamp: 123456 }],
        },
      });

      const result = await generateAnswer(stateWithExistingErrors, mockConfig, mockEnv);

      expect(result.metadata?.errors).toHaveLength(2);
      expect(result.metadata?.errors?.[0]).toEqual({
        node: 'retrieve',
        message: 'Previous error',
        timestamp: 123456,
      });
      expect(result.metadata?.errors?.[1].node).toBe('generateAnswer');
    });

    it('should log errors with proper context', async () => {
      const { LlmService } = require('../src/services/llmService');
      const { logError } = require('@dome/common');
      LlmService.call.mockRejectedValueOnce(new Error('Test error'));

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Test error' }),
        'Error in generateAnswer',
        { traceId: 'existing-trace-id', spanId: 'test-span-id' }
      );
    });

    it('should end span with error when failure occurs', async () => {
      const { LlmService } = require('../src/services/llmService');
      const { ObservabilityService } = require('../src/services/observabilityService');
      LlmService.call.mockRejectedValueOnce(new Error('Test error'));

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(ObservabilityService.endSpan).toHaveBeenCalledWith(
        mockEnv,
        'existing-trace-id',
        'test-span-id',
        'generateAnswer',
        mockState,
        mockState,
        expect.any(Number)
      );
    });
  });

  describe('message building', () => {
    it('should build messages with correct parameters', async () => {
      const { buildMessages } = require('../src/utils');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(buildMessages).toHaveBeenCalledWith(
        expect.stringContaining('System: Generate a comprehensive answer'),
        mockState.chatHistory,
        'What is artificial intelligence?'
      );
    });

    it('should handle complex chat history', async () => {
      const stateWithHistory = createMockState({
        chatHistory: [
          {
            user: { role: 'user', content: 'Previous question' },
            assistant: { role: 'assistant', content: 'Previous answer' },
            timestamp: 123456,
          },
        ],
      });

      await generateAnswer(stateWithHistory, mockConfig, mockEnv);

      expect(require('../src/utils').buildMessages).toHaveBeenCalledWith(
        expect.any(String),
        stateWithHistory.chatHistory,
        'What is artificial intelligence?'
      );
    });
  });

  describe('performance and optimization', () => {
    it('should handle large context efficiently', async () => {
      const largeContent = 'A'.repeat(10000);
      const stateWithLargeContext = createMockState({
        docs: [
          {
            content: largeContent,
            metadata: { source: 'large-doc.pdf' },
            id: 'large-doc',
            score: 0.9,
          },
        ],
      });

      const result = await generateAnswer(stateWithLargeContext, mockConfig, mockEnv);

      expect(result.generatedText).toBe('Generated answer response');
      expect(require('@dome/common').countTokens).toHaveBeenCalledWith(largeContent);
    });

    it('should track token usage for observability', async () => {
      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(require('../src/services/observabilityService').ObservabilityService.logEvent).toHaveBeenCalledWith(
        mockEnv,
        'existing-trace-id',
        'test-span-id',
        'context_stats',
        expect.objectContaining({
          contextTokens: expect.any(Number),
          userQueryTokens: expect.any(Number),
          maxResponseTokens: expect.any(Number),
          totalPromptTokens: expect.any(Number),
        })
      );
    });
  });
});