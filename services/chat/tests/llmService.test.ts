import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmService } from '../src/services/llmService';
import { AIMessage } from '../src/types';

// Mock dependencies following the constellation pattern
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
      maxContextTokens: 8000,
      defaultTemperature: 0.3,
      capabilities: { streaming: true, tools: true },
    },
    {
      id: 'gpt-4o',
      provider: 'openai',
      maxContextTokens: 16000,
      defaultTemperature: 0.3,
      capabilities: { streaming: true, tools: true, structuredOutput: true },
    },
  ],
  getDefaultModel: vi.fn(() => ({ id: 'gpt-4-turbo' })),
  ModelRegistry: vi.fn().mockImplementation(() => ({
    getModel: vi.fn((id?: string) => ({
      id: id || 'gpt-4-turbo',
      provider: 'openai',
      maxContextTokens: 8000,
      defaultTemperature: 0.3,
      capabilities: { streaming: true, tools: true },
    })),
    setDefaultModel: vi.fn(),
  })),
  ModelProvider: {
    OPENAI: 'openai',
    CLOUDFLARE: 'cloudflare',
    ANTHROPIC: 'anthropic',
  },
  chooseModel: vi.fn(() => ({
    id: 'gpt-4-turbo',
    provider: 'openai',
    maxContextTokens: 8000,
    defaultTemperature: 0.3,
  })),
  TaskKind: {},
  allocateContext: vi.fn(() => ({
    maxResponse: 1000,
    maxContext: 8000,
  })),
}));

vi.mock('../config', () => ({
  getTimeoutConfig: () => ({
    llmServiceTimeout: 30000,
  }),
}));

vi.mock('../services/modelFactory', () => ({
  ModelFactory: {
    createToolBoundModel: vi.fn(),
    createStructuredOutputModel: vi.fn(),
  },
}));

// Mock LangChain components
const mockChatOpenAI = {
  pipe: vi.fn(),
  stream: vi.fn(),
};

const mockOutputParser = {
  invoke: vi.fn(),
};

const mockChain = {
  invoke: vi.fn(),
};

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn(() => mockChatOpenAI),
}));

vi.mock('@langchain/core/output_parsers', () => ({
  StringOutputParser: vi.fn(() => mockOutputParser),
}));

vi.mock('@langchain/core/messages', () => ({
  HumanMessage: vi.fn((content) => ({ role: 'human', content })),
  SystemMessage: vi.fn((content) => ({ role: 'system', content })),
  AIMessage: vi.fn((content) => ({ role: 'ai', content })),
}));

const mockEnv = {
  OPENAI_API_KEY: 'test-api-key',
} as Env;

describe('LlmService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatOpenAI.pipe.mockReturnValue(mockChain);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('call', () => {
    it('should make a successful LLM call', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Hello, world!' },
      ];

      mockChain.invoke.mockResolvedValue('Hello! How can I help you?');

      const result = await LlmService.call(mockEnv, messages);

      expect(result).toBe('Hello! How can I help you?');
      expect(mockChain.invoke).toHaveBeenCalled();
    });

    it('should handle LLM call failures gracefully', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Test error' },
      ];

      mockChain.invoke.mockRejectedValue(new Error('API error'));

      const result = await LlmService.call(mockEnv, messages);

      expect(result).toBe("I'm sorry, but I couldn't process that just now – please try again.");
    });

    it('should handle empty response', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Test empty' },
      ];

      mockChain.invoke.mockResolvedValue('');

      const result = await LlmService.call(mockEnv, messages);

      expect(result).toBe("I'm sorry, but I couldn't process that just now – please try again.");
    });

    it('should use custom temperature and max tokens', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Custom params test' },
      ];

      const { ChatOpenAI } = require('@langchain/openai');
      mockChain.invoke.mockResolvedValue('Custom response');

      await LlmService.call(mockEnv, messages, {
        temperature: 0.8,
        maxTokens: 2000,
        modelId: 'gpt-4o',
      });

      expect(ChatOpenAI).toHaveBeenCalledWith({
        modelName: 'gpt-4o',
        temperature: 0.8,
        maxTokens: 2000,
        streaming: false,
        openAIApiKey: 'test-api-key',
      });
    });

    it('should use fallback API key when none provided', async () => {
      const envWithoutKey = {} as Env;
      const messages: AIMessage[] = [
        { role: 'user', content: 'Test fallback' },
      ];

      const { ChatOpenAI } = require('@langchain/openai');
      mockChain.invoke.mockResolvedValue('Response');

      await LlmService.call(envWithoutKey, messages);

      expect(ChatOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          openAIApiKey: 'sk-dummy-key-for-testing',
        })
      );
    });
  });

  describe('invokeStructured', () => {
    it('should invoke LLM with structured output', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Structure this data' },
      ];

      const mockSchema = { parse: vi.fn() };
      const mockModel = {
        withStructuredOutput: vi.fn().mockReturnValue({
          invoke: vi.fn().mockResolvedValue({ structured: 'data' }),
        }),
      };

      const { ModelFactory } = require('../services/modelFactory');
      ModelFactory.createStructuredOutputModel.mockReturnValue(mockModel);

      const result = await LlmService.invokeStructured(mockEnv, messages, {
        schema: mockSchema as any,
        schemaInstructions: 'Parse as JSON',
        task: 'generation' as any,
        quality: 'high',
      });

      expect(result).toEqual({ structured: 'data' });
      expect(ModelFactory.createStructuredOutputModel).toHaveBeenCalled();
      expect(mockModel.withStructuredOutput).toHaveBeenCalledWith(mockSchema);
    });

    it('should handle structured output errors', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Error test' },
      ];

      const mockSchema = { parse: vi.fn() };
      const { ModelFactory } = require('../services/modelFactory');
      ModelFactory.createStructuredOutputModel.mockImplementation(() => {
        throw new Error('Model creation failed');
      });

      await expect(
        LlmService.invokeStructured(mockEnv, messages, {
          schema: mockSchema as any,
          schemaInstructions: 'Parse as JSON',
        })
      ).rejects.toThrow('Failed to get structured output');
    });

    it('should use appropriate model for structured output', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Test model selection' },
      ];

      const mockSchema = { parse: vi.fn() };
      const { chooseModel, allocateContext } = require('@dome/common');
      
      chooseModel.mockReturnValue({
        id: 'gpt-4o',
        maxContextTokens: 16000,
      });

      allocateContext.mockReturnValue({
        maxResponse: 2000,
      });

      const mockModel = {
        withStructuredOutput: vi.fn().mockReturnValue({
          invoke: vi.fn().mockResolvedValue({ result: 'structured' }),
        }),
      };

      const { ModelFactory } = require('../services/modelFactory');
      ModelFactory.createStructuredOutputModel.mockReturnValue(mockModel);

      await LlmService.invokeStructured(mockEnv, messages, {
        schema: mockSchema as any,
        schemaInstructions: 'Parse data',
        task: 'generation' as any,
        quality: 'high',
      });

      expect(chooseModel).toHaveBeenCalledWith({
        task: 'generation',
        quality: 'high',
      });
      expect(allocateContext).toHaveBeenCalled();
      expect(ModelFactory.createStructuredOutputModel).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          modelId: 'gpt-4o',
          maxTokens: 2000,
        })
      );
    });
  });

  describe('stream', () => {
    it('should stream LLM responses', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Stream this response' },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { content: 'Hello' };
          yield { content: ' world' };
          yield { content: '!' };
        },
      };

      mockChatOpenAI.stream.mockResolvedValue(mockStream);

      const generator = LlmService.stream(mockEnv, messages);
      const chunks = [];

      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Hello', ' world', '!']);
      expect(mockChatOpenAI.stream).toHaveBeenCalled();
    });

    it('should handle streaming errors gracefully', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Stream error test' },
      ];

      mockChatOpenAI.stream.mockRejectedValue(new Error('Streaming failed'));

      const generator = LlmService.stream(mockEnv, messages);
      const chunks = [];

      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(["I'm sorry, but I couldn't process that just now – please try again."]);
    });

    it('should use streaming-enabled client configuration', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Test streaming config' },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { content: 'Streamed response' };
        },
      };

      mockChatOpenAI.stream.mockResolvedValue(mockStream);
      const { ChatOpenAI } = require('@langchain/openai');

      const generator = LlmService.stream(mockEnv, messages, {
        temperature: 0.5,
        maxTokens: 1500,
        modelId: 'gpt-4o',
      });

      // Consume the generator
      for await (const chunk of generator) {
        // Just consume
      }

      expect(ChatOpenAI).toHaveBeenCalledWith({
        modelName: 'gpt-4o',
        temperature: 0.5,
        maxTokens: 1500,
        streaming: true,
        openAIApiKey: 'test-api-key',
      });
    });

    it('should handle empty content in stream chunks', async () => {
      const messages: AIMessage[] = [
        { role: 'user', content: 'Test empty chunks' },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { content: '' }; // Empty chunk
          yield { content: 'Hello' };
          yield { content: null }; // Null chunk
          yield { content: 'World' };
        },
      };

      mockChatOpenAI.stream.mockResolvedValue(mockStream);

      const generator = LlmService.stream(mockEnv, messages);
      const chunks = [];

      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Should only yield non-empty content
      expect(chunks).toEqual(['Hello', 'World']);
    });
  });

  describe('createToolBoundLLM', () => {
    it('should create a tool-bound LLM successfully', () => {
      const mockTools = [
        { name: 'tool1', description: 'Test tool 1' },
        { name: 'tool2', description: 'Test tool 2' },
      ] as any;

      const mockToolBoundModel = { id: 'tool-bound-model' };
      const { ModelFactory } = require('../services/modelFactory');
      ModelFactory.createToolBoundModel.mockReturnValue(mockToolBoundModel);

      const result = LlmService.createToolBoundLLM(mockEnv, mockTools, {
        temperature: 0.7,
        maxTokens: 2000,
        modelId: 'gpt-4o',
      });

      expect(result).toBe(mockToolBoundModel);
      expect(ModelFactory.createToolBoundModel).toHaveBeenCalledWith(
        mockEnv,
        mockTools,
        {
          modelId: 'gpt-4o',
          temperature: 0.7,
          maxTokens: 2000,
        }
      );
    });

    it('should fall back to default model on failure', () => {
      const mockTools = [] as any;
      const { ModelFactory } = require('../services/modelFactory');
      const { getDefaultModel } = require('@dome/common');

      getDefaultModel.mockReturnValue({ id: 'gpt-4-turbo' });

      // First call fails
      ModelFactory.createToolBoundModel
        .mockImplementationOnce(() => {
          throw new Error('Custom model failed');
        })
        .mockReturnValueOnce({ id: 'fallback-model' });

      const result = LlmService.createToolBoundLLM(mockEnv, mockTools, {
        modelId: 'custom-model',
      });

      expect(result).toEqual({ id: 'fallback-model' });
      expect(ModelFactory.createToolBoundModel).toHaveBeenCalledTimes(2);
    });

    it('should throw error if default model also fails', () => {
      const mockTools = [] as any;
      const { ModelFactory } = require('../services/modelFactory');
      const { getDefaultModel } = require('@dome/common');

      getDefaultModel.mockReturnValue({ id: 'gpt-4-turbo' });

      ModelFactory.createToolBoundModel.mockImplementation(() => {
        throw new Error('Model creation failed');
      });

      expect(() =>
        LlmService.createToolBoundLLM(mockEnv, mockTools, {
          modelId: 'gpt-4-turbo', // Same as default
        })
      ).toThrow('Model creation failed');
    });
  });

  describe('message conversion', () => {
    it('should convert messages to LangChain format correctly', async () => {
      const messages: AIMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const { HumanMessage, SystemMessage, AIMessage: LangChainAIMessage } = require('@langchain/core/messages');
      mockChain.invoke.mockResolvedValue('Response');

      await LlmService.call(mockEnv, messages);

      expect(mockChain.invoke).toHaveBeenCalledWith([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'human' }),
        expect.objectContaining({ role: 'ai' }),
      ]);

      expect(SystemMessage).toHaveBeenCalledWith('You are a helpful assistant');
      expect(HumanMessage).toHaveBeenCalledWith('Hello');
      expect(LangChainAIMessage).toHaveBeenCalledWith('Hi there!');
    });
  });

  describe('provider-specific configuration', () => {
    it('should handle Cloudflare provider configuration', async () => {
      const { ModelRegistry } = require('@dome/common');
      const mockRegistry = new ModelRegistry();
      mockRegistry.getModel.mockReturnValue({
        id: 'cf-model',
        provider: 'cloudflare',
        maxContextTokens: 4000,
        defaultTemperature: 0.5,
        capabilities: { streaming: true },
      });

      // Mock the static registry
      LlmService['MODEL_REGISTRY'] = mockRegistry;

      const messages: AIMessage[] = [{ role: 'user', content: 'Test CF' }];
      mockChain.invoke.mockResolvedValue('CF Response');

      await LlmService.call(mockEnv, messages, { modelId: 'cf-model' });

      // Should still use OpenAI client for now (as per implementation)
      const { ChatOpenAI } = require('@langchain/openai');
      expect(ChatOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          modelName: 'cf-model',
          temperature: 0.5,
        })
      );
    });

    it('should handle Anthropic provider configuration', async () => {
      const { ModelRegistry } = require('@dome/common');
      const mockRegistry = new ModelRegistry();
      mockRegistry.getModel.mockReturnValue({
        id: 'claude-3',
        provider: 'anthropic',
        maxContextTokens: 12000,
        defaultTemperature: 0.2,
        capabilities: { streaming: true },
      });

      LlmService['MODEL_REGISTRY'] = mockRegistry;

      const messages: AIMessage[] = [{ role: 'user', content: 'Test Anthropic' }];
      mockChain.invoke.mockResolvedValue('Anthropic Response');

      await LlmService.call(mockEnv, messages, { modelId: 'claude-3' });

      // Should still use OpenAI client for now (as per implementation)
      const { ChatOpenAI } = require('@langchain/openai');
      expect(ChatOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          modelName: 'claude-3',
          temperature: 0.2,
        })
      );
    });
  });
});