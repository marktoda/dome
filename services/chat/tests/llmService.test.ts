import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmService } from '../src/services/llmService';
import { AIMessage } from '../src/types';

// Mock all external dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logError: vi.fn(),
  MODELS: {
    OPENAI: {
      GPT_4_TURBO: { id: 'gpt-4-turbo' },
      GPT_4o: { id: 'gpt-4o' },
    },
  },
  ALL_MODELS_ARRAY: [
    {
      id: 'gpt-4-turbo',
      provider: 'openai',
      defaultTemperature: 0.7,
      capabilities: { streaming: true },
    },
    {
      id: 'gpt-4o',
      provider: 'openai',
      defaultTemperature: 0.7,
      capabilities: { streaming: true },
    },
  ],
  getDefaultModel: () => ({ id: 'gpt-4-turbo' }),
  ModelRegistry: vi.fn().mockImplementation(() => ({
    getModel: vi.fn((id?: string) => ({
      id: id || 'gpt-4-turbo',
      provider: 'openai',
      defaultTemperature: 0.7,
      capabilities: { streaming: true },
    })),
    setDefaultModel: vi.fn(),
  })),
  ModelProvider: {
    OPENAI: 'openai',
    CLOUDFLARE: 'cloudflare',
    ANTHROPIC: 'anthropic',
  },
  chooseModel: vi.fn(() => ({ id: 'gpt-4-turbo' })),
  TaskKind: {
    GENERATION: 'generation',
    ANALYSIS: 'analysis',
  },
  allocateContext: vi.fn(() => ({ maxResponse: 1000 })),
}));

vi.mock('../src/services/modelFactory', () => ({
  ModelFactory: {
    createToolBoundModel: vi.fn(),
    createStructuredOutputModel: vi.fn(() => ({
      withStructuredOutput: vi.fn(() => ({
        invoke: vi.fn().mockResolvedValue({ result: 'structured response' }),
      })),
    })),
  },
}));

vi.mock('../src/config', () => ({
  getTimeoutConfig: () => ({ llmServiceTimeout: 30000 }),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    pipe: vi.fn(() => ({
      invoke: vi.fn().mockResolvedValue('LLM response'),
    })),
    stream: vi.fn().mockResolvedValue([
      { content: 'chunk1' },
      { content: 'chunk2' },
      { content: 'chunk3' },
    ]),
  })),
}));

vi.mock('@langchain/core/messages', () => ({
  HumanMessage: vi.fn().mockImplementation((content) => ({ type: 'human', content })),
  SystemMessage: vi.fn().mockImplementation((content) => ({ type: 'system', content })),
  AIMessage: vi.fn().mockImplementation((content) => ({ type: 'ai', content })),
}));

vi.mock('@langchain/core/output_parsers', () => ({
  StringOutputParser: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@langchain/core/tools', () => ({
  Tool: class MockTool {
    name = 'mockTool';
    description = 'A mock tool';
  },
}));

vi.mock('zod', () => ({
  ZodSchema: class MockZodSchema {},
  z: {
    object: vi.fn(),
    string: vi.fn(),
  },
}));

describe('LlmService', () => {
  let mockEnv: any;
  const mockMessages: AIMessage[] = [
    { role: 'user', content: 'Hello, how can you help me?' },
    { role: 'assistant', content: 'I can help you with various tasks.' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      OPENAI_API_KEY: 'test-api-key',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('call', () => {
    it('should return LLM response for valid input', async () => {
      const result = await LlmService.call(mockEnv, mockMessages);

      expect(result).toBe('LLM response');
      expect(require('@langchain/openai').ChatOpenAI).toHaveBeenCalled();
    });

    it('should handle temperature and maxTokens options', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;

      await LlmService.call(mockEnv, mockMessages, {
        temperature: 0.5,
        maxTokens: 2000,
      });

      expect(ChatOpenAI).toHaveBeenCalledWith({
        modelName: 'gpt-4-turbo',
        temperature: 0.5,
        maxTokens: 2000,
        streaming: false,
        openAIApiKey: 'test-api-key',
      });
    });

    it('should handle custom modelId', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;

      await LlmService.call(mockEnv, mockMessages, {
        modelId: 'gpt-4o',
      });

      expect(ChatOpenAI).toHaveBeenCalledWith({
        modelName: 'gpt-4o',
        temperature: 0.7,
        maxTokens: undefined,
        streaming: false,
        openAIApiKey: 'test-api-key',
      });
    });

    it('should use fallback API key when not provided', async () => {
      const envWithoutKey = {};
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;

      await LlmService.call(envWithoutKey, mockMessages);

      expect(ChatOpenAI).toHaveBeenCalledWith({
        modelName: 'gpt-4-turbo',
        temperature: 0.7,
        maxTokens: undefined,
        streaming: false,
        openAIApiKey: 'sk-dummy-key-for-testing',
      });
    });

    it('should return fallback response on error', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;
      ChatOpenAI.mockImplementation(() => {
        throw new Error('LLM service unavailable');
      });

      const result = await LlmService.call(mockEnv, mockMessages);

      expect(result).toBe("I'm sorry, but I couldn't process that just now – please try again.");
    });

    it('should handle timeout scenarios', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;
      ChatOpenAI.mockImplementation(() => ({
        pipe: vi.fn(() => ({
          invoke: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 35000))), // Longer than timeout
        })),
      }));

      const result = await LlmService.call(mockEnv, mockMessages);

      expect(result).toBe("I'm sorry, but I couldn't process that just now – please try again.");
    });

    it('should convert messages to LangChain format correctly', async () => {
      const { HumanMessage, SystemMessage, AIMessage } = require('@langchain/core/messages');

      const mixedMessages: AIMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      await LlmService.call(mockEnv, mixedMessages);

      expect(SystemMessage).toHaveBeenCalledWith('You are a helpful assistant');
      expect(HumanMessage).toHaveBeenCalledWith('Hello');
      expect(AIMessage).toHaveBeenCalledWith('Hi there!');
    });
  });

  describe('stream', () => {
    it('should stream LLM responses', async () => {
      const chunks: string[] = [];

      for await (const chunk of LlmService.stream(mockEnv, mockMessages)) {
        chunks.push(chunk as string);
      }

      expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
    });

    it('should handle streaming options', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;

      const streamGenerator = LlmService.stream(mockEnv, mockMessages, {
        temperature: 0.3,
        maxTokens: 1500,
        modelId: 'gpt-4o',
      });

      // Start the generator to trigger the ChatOpenAI call
      const { value } = await streamGenerator.next();

      expect(ChatOpenAI).toHaveBeenCalledWith({
        modelName: 'gpt-4o',
        temperature: 0.3,
        maxTokens: 1500,
        streaming: true,
        openAIApiKey: 'test-api-key',
      });
    });

    it('should handle streaming errors gracefully', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;
      ChatOpenAI.mockImplementation(() => ({
        stream: vi.fn().mockRejectedValue(new Error('Streaming failed')),
      }));

      const chunks: string[] = [];
      for await (const chunk of LlmService.stream(mockEnv, mockMessages)) {
        chunks.push(chunk as string);
      }

      expect(chunks).toEqual(["I'm sorry, but I couldn't process that just now – please try again."]);
    });

    it('should filter out empty chunks', async () => {
      const ChatOpenAI = require('@langchain/openai').ChatOpenAI;
      ChatOpenAI.mockImplementation(() => ({
        stream: vi.fn().mockResolvedValue([
          { content: 'chunk1' },
          { content: '' }, // Empty chunk
          { content: null }, // Null chunk
          { content: 'chunk2' },
        ]),
      }));

      const chunks: string[] = [];
      for await (const chunk of LlmService.stream(mockEnv, mockMessages)) {
        chunks.push(chunk as string);
      }

      expect(chunks).toEqual(['chunk1', 'chunk2']);
    });
  });

  describe('invokeStructured', () => {
    it('should return structured output', async () => {
      const mockSchema = { parse: vi.fn() };
      const result = await LlmService.invokeStructured(mockEnv, mockMessages, {
        schema: mockSchema as any,
        schemaInstructions: 'Return a structured response',
      });

      expect(result).toEqual({ result: 'structured response' });
      expect(require('../src/services/modelFactory').ModelFactory.createStructuredOutputModel).toHaveBeenCalled();
    });

    it('should handle structured output options', async () => {
      const mockSchema = { parse: vi.fn() };
      const { chooseModel, allocateContext } = require('@dome/common');

      await LlmService.invokeStructured(mockEnv, mockMessages, {
        schema: mockSchema as any,
        schemaInstructions: 'Return structured data',
        temperature: 0.1,
        task: 'analysis' as any,
        quality: 'high' as any,
      });

      expect(chooseModel).toHaveBeenCalledWith({ task: 'analysis', quality: 'high' });
      expect(allocateContext).toHaveBeenCalled();
    });

    it('should handle structured output errors', async () => {
      const { ModelFactory } = require('../src/services/modelFactory');
      ModelFactory.createStructuredOutputModel.mockImplementation(() => {
        throw new Error('Structured output failed');
      });

      const mockSchema = { parse: vi.fn() };

      await expect(
        LlmService.invokeStructured(mockEnv, mockMessages, {
          schema: mockSchema as any,
          schemaInstructions: 'Return structured data',
        })
      ).rejects.toThrow('Failed to get structured output: Structured output failed');
    });

    it('should use default task when not specified', async () => {
      const { chooseModel } = require('@dome/common');
      const mockSchema = { parse: vi.fn() };

      await LlmService.invokeStructured(mockEnv, mockMessages, {
        schema: mockSchema as any,
        schemaInstructions: 'Return structured data',
      });

      expect(chooseModel).toHaveBeenCalledWith({ task: 'generation', quality: undefined });
    });
  });

  describe('createToolBoundLLM', () => {
    it('should create tool-bound LLM successfully', () => {
      const mockTools = [new (require('@langchain/core/tools').Tool)()];
      const { ModelFactory } = require('../src/services/modelFactory');
      const mockModel = { name: 'tool-bound-model' };
      ModelFactory.createToolBoundModel.mockReturnValue(mockModel);

      const result = LlmService.createToolBoundLLM(mockEnv, mockTools);

      expect(result).toBe(mockModel);
      expect(ModelFactory.createToolBoundModel).toHaveBeenCalledWith(mockEnv, mockTools, {
        modelId: 'gpt-4-turbo',
        temperature: undefined,
        maxTokens: undefined,
      });
    });

    it('should handle tool binding with custom options', () => {
      const mockTools = [new (require('@langchain/core/tools').Tool)()];
      const { ModelFactory } = require('../src/services/modelFactory');

      LlmService.createToolBoundLLM(mockEnv, mockTools, {
        temperature: 0.2,
        maxTokens: 1200,
        modelId: 'gpt-4o',
      });

      expect(ModelFactory.createToolBoundModel).toHaveBeenCalledWith(mockEnv, mockTools, {
        modelId: 'gpt-4o',
        temperature: 0.2,
        maxTokens: 1200,
      });
    });

    it('should fallback to default model on failure', () => {
      const mockTools = [new (require('@langchain/core/tools').Tool)()];
      const { ModelFactory } = require('../src/services/modelFactory');

      // Mock first call to fail, second to succeed
      ModelFactory.createToolBoundModel
        .mockImplementationOnce(() => {
          throw new Error('Custom model failed');
        })
        .mockReturnValueOnce({ name: 'fallback-model' });

      const result = LlmService.createToolBoundLLM(mockEnv, mockTools, {
        modelId: 'gpt-4o',
      });

      expect(result).toEqual({ name: 'fallback-model' });
      expect(ModelFactory.createToolBoundModel).toHaveBeenCalledTimes(2);
      expect(ModelFactory.createToolBoundModel).toHaveBeenNthCalledWith(2, mockEnv, mockTools, {
        temperature: undefined,
        maxTokens: undefined,
      });
    });

    it('should throw error if default model also fails', () => {
      const mockTools = [new (require('@langchain/core/tools').Tool)()];
      const { ModelFactory } = require('../src/services/modelFactory');

      ModelFactory.createToolBoundModel.mockImplementation(() => {
        throw new Error('All models failed');
      });

      expect(() =>
        LlmService.createToolBoundLLM(mockEnv, mockTools, {
          modelId: 'gpt-4-turbo', // Same as default
        })
      ).toThrow('All models failed');
    });
  });

  describe('provider handling', () => {
    it('should handle different model providers', async () => {
      const { ModelRegistry } = require('@dome/common');
      const mockGetModel = vi.fn();

      // Test different providers
      const providers = [
        { provider: 'openai', id: 'gpt-4' },
        { provider: 'cloudflare', id: 'cf-model' },
        { provider: 'anthropic', id: 'claude-3' },
        { provider: 'unknown', id: 'unknown-model' },
      ];

      for (const providerTest of providers) {
        mockGetModel.mockReturnValue({
          id: providerTest.id,
          provider: providerTest.provider,
          defaultTemperature: 0.7,
          capabilities: { streaming: true },
        });

        const mockRegistry = new ModelRegistry();
        mockRegistry.getModel = mockGetModel;
        LlmService['MODEL_REGISTRY'] = mockRegistry;

        await LlmService.call(mockEnv, mockMessages, { modelId: providerTest.id });

        expect(require('@langchain/openai').ChatOpenAI).toHaveBeenCalledWith(
          expect.objectContaining({
            modelName: providerTest.id,
            openAIApiKey: 'test-api-key',
          })
        );
      }
    });

    it('should warn when model does not support streaming', async () => {
      const { getLogger, ModelRegistry } = require('@dome/common');
      const mockLogger = getLogger();
      const mockGetModel = vi.fn().mockReturnValue({
        id: 'non-streaming-model',
        provider: 'openai',
        defaultTemperature: 0.7,
        capabilities: { streaming: false },
      });

      const mockRegistry = new ModelRegistry();
      mockRegistry.getModel = mockGetModel;
      LlmService['MODEL_REGISTRY'] = mockRegistry;

      const streamGenerator = LlmService.stream(mockEnv, mockMessages, {
        modelId: 'non-streaming-model',
      });
      await streamGenerator.next();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { modelId: 'non-streaming-model' },
        'Model does not support streaming, using non-streaming client'
      );
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages array', async () => {
      const result = await LlmService.call(mockEnv, []);
      expect(result).toBe('LLM response');
    });

    it('should handle malformed messages gracefully', async () => {
      const malformedMessages = [
        { role: 'invalid_role', content: 'test' } as any,
        { role: 'user', content: null } as any,
      ];

      // Should not throw, but may produce unexpected LangChain message types
      await expect(LlmService.call(mockEnv, malformedMessages)).resolves.toBeDefined();
    });

    it('should handle very long content', async () => {
      const longContent = 'a'.repeat(10000);
      const longMessages: AIMessage[] = [
        { role: 'user', content: longContent },
      ];

      const result = await LlmService.call(mockEnv, longMessages);
      expect(result).toBe('LLM response');
    });
  });
});