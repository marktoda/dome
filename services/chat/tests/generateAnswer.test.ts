import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateAnswer } from '../src/nodes/generateAnswer';
import { AgentStateV3 as AgentState } from '../src/types/stateSlices';
import { LangGraphRunnableConfig } from '@langchain/langgraph';

// Mock all dependencies following the constellation pattern
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  logError: vi.fn(),
  countTokens: vi.fn((text: string) => text.length), // Simple mock for token counting
  chooseModel: vi.fn(() => ({
    id: 'gpt-4-turbo',
    maxContextTokens: 8000,
    provider: 'openai',
  })),
  allocateContext: vi.fn(() => ({
    maxResponse: 1000,
    maxContext: 8000,
  })),
}));

vi.mock('@dome/common/errors', () => ({
  toDomeError: (e: any) => e,
}));

vi.mock('../src/services/llmService', () => ({
  LlmService: {
    call: vi.fn(),
    stream: vi.fn(),
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
  formatDocsForPrompt: vi.fn((docs) => docs.map((d: any) => d.content).join('\n')),
}));

vi.mock('../src/utils', () => ({
  buildMessages: vi.fn((systemPrompt, chatHistory, userQuery) => [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userQuery },
  ]),
}));

vi.mock('../src/config/promptsConfig', () => ({
  getGenerateAnswerPrompt: vi.fn((userQuery, docContext) => 
    `Answer the question based on context: ${userQuery}\n\nContext: ${docContext}`
  ),
}));

const mockEnv = {
  OPENAI_API_KEY: 'test-key',
} as Env;

describe('generateAnswer', () => {
  let mockState: AgentState;
  let mockConfig: LangGraphRunnableConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockState = {
      messages: [
        { role: 'user', content: 'What is the capital of France?', timestamp: Date.now() },
      ],
      docs: [
        { content: 'Paris is the capital of France', id: 'doc1', metadata: {} },
        { content: 'France is a country in Europe', id: 'doc2', metadata: {} },
      ],
      chatHistory: [],
      metadata: {},
      options: {},
      userId: 'test-user',
    } as AgentState;

    mockConfig = {
      configurable: {},
    } as LangGraphRunnableConfig;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('successful answer generation', () => {
    it('should generate an answer successfully', async () => {
      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockResolvedValue('Paris is the capital of France.');

      const result = await generateAnswer(mockState, mockConfig, mockEnv);

      expect(result).toMatchObject({
        generatedText: 'Paris is the capital of France.',
        metadata: expect.objectContaining({
          currentNode: 'generateAnswer',
          isFinalState: true,
          executionTimeMs: expect.any(Number),
        }),
      });

      expect(LlmService.call).toHaveBeenCalledWith(
        mockEnv,
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user', content: 'What is the capital of France?' }),
        ]),
        expect.objectContaining({
          modelId: 'gpt-4-turbo',
          temperature: 0.3,
          maxTokens: 1000,
        })
      );
    });

    it('should use custom temperature from options', async () => {
      const stateWithOptions = {
        ...mockState,
        options: { temperature: 0.8 },
      };

      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockResolvedValue('Custom temperature response');

      await generateAnswer(stateWithOptions, mockConfig, mockEnv);

      expect(LlmService.call).toHaveBeenCalledWith(
        mockEnv,
        expect.any(Array),
        expect.objectContaining({
          temperature: 0.8,
        })
      );
    });

    it('should use custom model from options', async () => {
      const stateWithModel = {
        ...mockState,
        options: { modelId: 'gpt-4o' },
      };

      const { chooseModel } = require('@dome/common');
      chooseModel.mockReturnValue({
        id: 'gpt-4o',
        maxContextTokens: 16000,
      });

      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockResolvedValue('Custom model response');

      await generateAnswer(stateWithModel, mockConfig, mockEnv);

      expect(chooseModel).toHaveBeenCalledWith({
        task: 'generation',
        explicitId: 'gpt-4o',
      });
    });
  });

  describe('streaming mode', () => {
    it('should handle streaming mode correctly', async () => {
      const mockStreamConfig = {
        configurable: {
          stream: {
            handleChunk: vi.fn(),
          },
        },
      } as LangGraphRunnableConfig;

      const { LlmService } = require('../src/services/llmService');
      
      // Mock async generator for streaming
      const mockStreamGenerator = async function* () {
        yield 'Paris ';
        yield 'is ';
        yield 'the capital ';
        yield 'of France.';
      };
      
      LlmService.stream.mockReturnValue(mockStreamGenerator());

      const result = await generateAnswer(mockState, mockStreamConfig, mockEnv);

      expect(result.generatedText).toBe('Paris is the capital of France.');
      expect(mockStreamConfig.configurable?.stream?.handleChunk).toHaveBeenCalledTimes(4);
      expect(LlmService.stream).toHaveBeenCalledWith(
        mockEnv,
        expect.any(Array),
        expect.objectContaining({
          modelId: 'gpt-4-turbo',
          temperature: 0.3,
          maxTokens: 1000,
        })
      );
    });

    it('should include metadata in stream chunks', async () => {
      const mockStreamConfig = {
        configurable: {
          stream: {
            handleChunk: vi.fn(),
          },
        },
      } as LangGraphRunnableConfig;

      const { LlmService } = require('../src/services/llmService');
      const mockStreamGenerator = async function* () {
        yield 'Test chunk';
      };
      
      LlmService.stream.mockReturnValue(mockStreamGenerator());

      await generateAnswer(mockState, mockStreamConfig, mockEnv);

      expect(mockStreamConfig.configurable?.stream?.handleChunk).toHaveBeenCalledWith({
        event: 'on_chat_model_stream',
        data: { chunk: 'Test chunk' },
        metadata: {
          langgraph_node: 'generateAnswer',
          traceId: expect.any(String),
          spanId: 'test-span-id',
        },
      });
    });
  });

  describe('observability and logging', () => {
    it('should track observability correctly', async () => {
      const { ObservabilityService } = require('../src/services/observabilityService');
      const { LlmService } = require('../src/services/llmService');
      
      LlmService.call.mockResolvedValue('Test response');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(ObservabilityService.startSpan).toHaveBeenCalledWith(
        mockEnv,
        expect.any(String),
        'generateAnswer',
        mockState
      );

      expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
        mockEnv,
        expect.any(String),
        'test-span-id',
        'context_stats',
        expect.objectContaining({
          contextTokens: expect.any(Number),
          userQueryTokens: expect.any(Number),
          maxResponseTokens: expect.any(Number),
        })
      );

      expect(ObservabilityService.endSpan).toHaveBeenCalledWith(
        mockEnv,
        expect.any(String),
        'test-span-id',
        'generateAnswer',
        mockState,
        mockState,
        expect.any(Number)
      );
    });

    it('should calculate token usage correctly', async () => {
      const { countTokens } = require('@dome/common');
      const { LlmService } = require('../src/services/llmService');
      
      countTokens.mockImplementation((text: string) => text.length);
      LlmService.call.mockResolvedValue('Response');

      await generateAnswer(mockState, mockConfig, mockEnv);

      // Should count tokens for user query and document context
      expect(countTokens).toHaveBeenCalledWith('What is the capital of France?');
      expect(countTokens).toHaveBeenCalledWith(expect.stringContaining('Paris is the capital of France'));
    });

    it('should preserve existing metadata and add node timing', async () => {
      const stateWithMetadata = {
        ...mockState,
        metadata: {
          traceId: 'existing-trace',
          nodeTimings: { previousNode: 100 },
        },
      };

      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockResolvedValue('Response');

      const result = await generateAnswer(stateWithMetadata, mockConfig, mockEnv);

      expect(result.metadata?.nodeTimings).toEqual({
        previousNode: 100,
        generateAnswer: expect.any(Number),
      });
    });
  });

  describe('error handling', () => {
    it('should handle missing documents gracefully', async () => {
      const stateWithoutDocs = {
        ...mockState,
        docs: undefined,
      };

      const result = await generateAnswer(stateWithoutDocs, mockConfig, mockEnv);

      expect(result.generatedText).toContain(
        'I apologize, but I encountered an issue while generating an answer'
      );
      expect(result.metadata?.errors).toHaveLength(1);
      expect(result.metadata?.errors?.[0]).toMatchObject({
        node: 'generateAnswer',
        message: expect.stringContaining('No synthesized context or documents found'),
      });
    });

    it('should handle LLM service errors gracefully', async () => {
      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockRejectedValue(new Error('LLM service failed'));

      const result = await generateAnswer(mockState, mockConfig, mockEnv);

      expect(result.generatedText).toContain(
        'I apologize, but I encountered an issue while generating an answer'
      );
      expect(result.metadata?.errors).toHaveLength(1);
      expect(result.metadata?.isFinalState).toBe(true);
    });

    it('should handle streaming errors gracefully', async () => {
      const mockStreamConfig = {
        configurable: {
          stream: {
            handleChunk: vi.fn(),
          },
        },
      } as LangGraphRunnableConfig;

      const { LlmService } = require('../src/services/llmService');
      LlmService.stream.mockImplementation(async function* () {
        throw new Error('Streaming failed');
      });

      const result = await generateAnswer(mockState, mockStreamConfig, mockEnv);

      expect(result.generatedText).toContain(
        'I apologize, but I encountered an issue while generating an answer'
      );
      expect(result.metadata?.errors).toHaveLength(1);
    });

    it('should preserve existing errors when adding new ones', async () => {
      const stateWithErrors = {
        ...mockState,
        metadata: {
          errors: [{ node: 'previousNode', message: 'Previous error', timestamp: Date.now() }],
        },
      };

      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockRejectedValue(new Error('New error'));

      const result = await generateAnswer(stateWithErrors, mockConfig, mockEnv);

      expect(result.metadata?.errors).toHaveLength(2);
      expect(result.metadata?.errors?.[0].node).toBe('previousNode');
      expect(result.metadata?.errors?.[1].node).toBe('generateAnswer');
    });
  });

  describe('prompt building', () => {
    it('should build prompts correctly with context', async () => {
      const { getGenerateAnswerPrompt } = require('../src/config/promptsConfig');
      const { formatDocsForPrompt } = require('../src/utils/promptHelpers');
      const { buildMessages } = require('../src/utils');
      const { LlmService } = require('../src/services/llmService');
      
      LlmService.call.mockResolvedValue('Response');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(formatDocsForPrompt).toHaveBeenCalledWith(mockState.docs);
      expect(getGenerateAnswerPrompt).toHaveBeenCalledWith(
        'What is the capital of France?',
        expect.stringContaining('Paris is the capital of France')
      );
      expect(buildMessages).toHaveBeenCalledWith(
        expect.stringContaining('Answer the question based on context'),
        mockState.chatHistory,
        'What is the capital of France?'
      );
    });

    it('should handle empty documents array', async () => {
      const stateWithEmptyDocs = {
        ...mockState,
        docs: [],
      };

      const result = await generateAnswer(stateWithEmptyDocs, mockConfig, mockEnv);

      expect(result.generatedText).toContain(
        'I apologize, but I encountered an issue while generating an answer'
      );
    });

    it('should include chat history in message building', async () => {
      const stateWithHistory = {
        ...mockState,
        chatHistory: [
          {
            user: { role: 'user' as const, content: 'Previous question' },
            assistant: { role: 'assistant' as const, content: 'Previous answer' },
            timestamp: Date.now() - 1000,
          },
        ],
      };

      const { buildMessages } = require('../src/utils');
      const { LlmService } = require('../src/services/llmService');
      
      LlmService.call.mockResolvedValue('Response');

      await generateAnswer(stateWithHistory, mockConfig, mockEnv);

      expect(buildMessages).toHaveBeenCalledWith(
        expect.any(String),
        stateWithHistory.chatHistory,
        'What is the capital of France?'
      );
    });
  });

  describe('context allocation', () => {
    it('should respect model context limits', async () => {
      const { allocateContext, chooseModel } = require('@dome/common');
      
      chooseModel.mockReturnValue({
        id: 'custom-model',
        maxContextTokens: 32000,
      });

      allocateContext.mockReturnValue({
        maxResponse: 4000,
        maxContext: 32000,
      });

      const { LlmService } = require('../src/services/llmService');
      LlmService.call.mockResolvedValue('Response');

      await generateAnswer(mockState, mockConfig, mockEnv);

      expect(allocateContext).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'custom-model',
          maxContextTokens: 32000,
        })
      );

      expect(LlmService.call).toHaveBeenCalledWith(
        mockEnv,
        expect.any(Array),
        expect.objectContaining({
          maxTokens: 4000,
        })
      );
    });
  });
});