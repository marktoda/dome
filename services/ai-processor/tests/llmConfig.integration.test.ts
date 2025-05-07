import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmService } from '../src/services/llmService';
import * as schemas from '../src/schemas';
import {
  getModelConfig,
  getDefaultModel,
  truncateToTokenLimit,
  countTokens,
  BaseModelConfig,
  ModelProvider,
  LlmEnvironment,
} from '@dome/common';

// Mock the common package's LLM functions and logging
vi.mock('@dome/common', () => {
  return {
    // Mock logging utilities
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
    logError: vi.fn(),
    trackOperation: vi.fn((name: string, fn: Function, ctx: any) => fn()),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
    },

    // Mock LLM functions
    getModelConfig: vi.fn(),
    getDefaultModel: vi.fn(),
    truncateToTokenLimit: vi.fn((content: string, limit: number) =>
      content.length > limit ? content.substring(0, limit) + '...' : content,
    ),
    countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)), // Simple mock that assumes 4 chars = 1 token

    // Expose types and enums
    ModelProvider: {
      OPENAI: 'openai',
      ANTHROPIC: 'anthropic',
      CLOUDFLARE: 'cloudflare',
      CUSTOM: 'custom',
    },
  };
});

// Mock schemas
vi.mock('../src/schemas', async () => {
  const actualSchemas = await vi.importActual('../src/schemas');
  return {
    ...actualSchemas,
    getSchemaForContentType: vi.fn().mockImplementation(contentType => {
      return {
        parse: vi.fn().mockImplementation(data => data),
      };
    }),
    getSchemaInstructions: vi.fn().mockImplementation(contentType => {
      return `Mock instructions for ${contentType}`;
    }),
  };
});

// Mock AI binding
const mockAi = {
  run: vi.fn(),
};

describe('LlmService - Common LLM Configuration Integration', () => {
  let env: any;
  let llmService: LlmService;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Default mock implementation for AI.run
    mockAi.run.mockResolvedValue({
      response: JSON.stringify({
        title: 'Test Title',
        summary: 'Test summary.',
        topics: ['test', 'example'],
      }),
    });

    // Create mock environment with LLM configuration
    env = {
      AI: mockAi,
      AI_MODEL_NAME: 'claude-3-sonnet-20240229',
      AI_TOKEN_LIMIT: '8000',
      OPENAI_API_KEY: 'test-openai-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      ENVIRONMENT: 'test',
    } as any; // Type assertion to Env

    // Create new service instance
    llmService = new LlmService(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('LLM Configuration', () => {
    it('should create an LLM service instance with environment configuration', () => {
      // Service should be instantiated with environment
      expect(llmService).toBeDefined();
      expect(llmService['env']).toBe(env);
    });
  });

  describe('Model Selection', () => {
    it('should use the model specified in the environment', async () => {
      // Process content to trigger model selection
      await llmService.processContent('Test content', 'note');

      // Should have called getModelConfig with the model name from env
      expect(getModelConfig).toHaveBeenCalledWith('claude-3-sonnet-20240229');

      // Check that AI was called with the right model
      expect(mockAi.run).toHaveBeenCalledWith('claude-3-sonnet-20240229', expect.anything());

      // Verify the model name is included in the result
      const result = await llmService.processContent('Test content', 'note');
      expect(result).toHaveProperty('modelUsed', 'claude-3-sonnet-20240229');
    });

    it('should fall back to default model if configured model is not found', async () => {
      // Mock getModelConfig to throw an error for our configured model
      vi.mocked(getModelConfig).mockImplementationOnce(() => {
        throw new Error('Model not found');
      });

      // Mock getDefaultModel to return a fallback model
      const defaultModel = {
        id: 'gpt-4-turbo',
        key: 'GPT_4_TURBO',
        name: 'GPT-4 Turbo',
        provider: ModelProvider.OPENAI,
        maxContextTokens: 128000,
        defaultTemperature: 0.7,
        defaultMaxTokens: 4096,
        capabilities: {
          streaming: true,
          structuredOutput: true,
          vision: false,
        },
        productionReady: true,
      } as BaseModelConfig;
      vi.mocked(getDefaultModel).mockReturnValueOnce(defaultModel);

      // Process content
      await llmService.processContent('Test content', 'note');

      // Should have tried the configured model first
      expect(getModelConfig).toHaveBeenCalledWith('claude-3-sonnet-20240229');

      // Should have fallen back to the default model
      expect(getDefaultModel).toHaveBeenCalledTimes(1);

      // Check that AI was called with the default model
      expect(mockAi.run).toHaveBeenCalledWith('gpt-4-turbo', expect.anything());
    });

    it('should use default model if none is configured', async () => {
      // Create environment without AI_MODEL_NAME
      const envWithoutModel = {
        ...env,
        AI: mockAi, // Make sure we maintain the AI reference
      } as any; // Type assertion to Env
      delete envWithoutModel.AI_MODEL_NAME;

      // Create a new service with the modified environment
      const serviceWithoutModel = new LlmService(envWithoutModel);

      // Mock getDefaultModel to return a specific model
      const defaultModel: BaseModelConfig = {
        id: 'gpt-4-turbo',
        key: 'GPT_4_TURBO',
        name: 'GPT-4 Turbo',
        provider: ModelProvider.OPENAI,
        maxContextTokens: 128000,
        defaultTemperature: 0.7,
        defaultMaxTokens: 4096,
        capabilities: {
          streaming: true,
          functionCalling: true,
          toolUse: true,
          structuredOutput: true,
          vision: false,
        },
        productionReady: true,
      };
      vi.mocked(getDefaultModel).mockReturnValueOnce(defaultModel);

      // Process content
      await serviceWithoutModel.processContent('Test content', 'note');

      // Should have used getDefaultModel since no model was configured
      expect(getDefaultModel).toHaveBeenCalledTimes(1);

      // Check that AI was called with the default model
      expect(mockAi.run).toHaveBeenCalledWith('gpt-4-turbo', expect.anything());
    });
  });

  describe('Token Counting and Truncation', () => {
    it('should count tokens using the common package function', async () => {
      // Mock countTokens to return a specific value
      vi.mocked(countTokens).mockReturnValueOnce(1000);

      // Process content with large text that would need truncation
      const longContent = 'A'.repeat(10000);
      await llmService.processContent(longContent, 'note');

      // Should have called countTokens
      expect(countTokens).toHaveBeenCalledWith(longContent);
    });

    it('should truncate content using the common package function', async () => {
      // Mock countTokens to simulate content exceeding token limit
      vi.mocked(countTokens).mockReturnValueOnce(10000);

      // Mock truncateToTokenLimit to return a specific truncated string
      const truncatedContent = 'Truncated content';
      vi.mocked(truncateToTokenLimit).mockReturnValueOnce(truncatedContent);

      // Process content with large text
      const longContent = 'A'.repeat(10000);
      await llmService.processContent(longContent, 'note');

      // Should have called truncateToTokenLimit with the right parameters
      expect(truncateToTokenLimit).toHaveBeenCalledWith(
        longContent,
        8000, // From env.AI_TOKEN_LIMIT
        expect.any(Function),
      );

      // Check that the truncated content was used in the AI call
      const prompt = mockAi.run.mock.calls[0][1].messages[0].content;
      expect(prompt).toContain(truncatedContent);
    });

    it('should use model token limit if no limit is configured', async () => {
      // Create environment without AI_TOKEN_LIMIT
      const envWithoutLimit = {
        ...env,
        AI: mockAi, // Make sure we maintain the AI reference
      } as any; // Type assertion to Env
      delete envWithoutLimit.AI_TOKEN_LIMIT;

      // Create a new service with the modified environment
      const serviceWithoutLimit = new LlmService(envWithoutLimit);

      // Mock getModelConfig to return a model with a specific token limit
      const modelConfig = {
        id: 'claude-3-sonnet-20240229',
        key: 'CLAUDE_3_SONNET',
        name: 'Claude 3 Sonnet',
        provider: ModelProvider.ANTHROPIC,
        maxContextTokens: 200000,
        defaultTemperature: 0.7,
        defaultMaxTokens: 8192,
        capabilities: {
          streaming: true,
          structuredOutput: true,
          vision: false,
        },
        productionReady: true,
      } as BaseModelConfig;
      vi.mocked(getModelConfig).mockReturnValueOnce(modelConfig);

      // Mock countTokens to simulate content exceeding token limit
      vi.mocked(countTokens).mockReturnValueOnce(300000);

      // Process content with large text
      const longContent = 'A'.repeat(10000);
      await serviceWithoutLimit.processContent(longContent, 'note');

      // Should have called truncateToTokenLimit with the model's limit
      expect(truncateToTokenLimit).toHaveBeenCalledWith(
        longContent,
        200000, // From model.maxContextTokens
        expect.any(Function),
      );
    });
  });

  describe('Existing Functionality', () => {
    it('should still process content and return structured metadata', async () => {
      // Process some content
      const result = await llmService.processContent('Test content', 'note');

      // Check that basic processing still works
      expect(result).toHaveProperty('title', 'Test Title');
      expect(result).toHaveProperty('summary', 'Test summary.');
      expect(result).toHaveProperty('topics', ['test', 'example']);
      expect(result).toHaveProperty('processingVersion', 3); // Updated to 3 in the new implementation
      expect(result).toHaveProperty('modelUsed');
    });

    it('should handle errors gracefully', async () => {
      // Mock AI to throw an error
      mockAi.run.mockRejectedValueOnce(new Error('AI processing failed'));

      try {
        await llmService.processContent('Test content', 'note');
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        // Should throw an error
        expect(error.message).toContain('All LLM processing attempts failed');
        expect(error.cause.message).toBe('AI processing failed');
      }
    });

    it('should extract JSON from markdown code blocks', async () => {
      // Mock AI to return JSON wrapped in markdown code blocks
      mockAi.run.mockResolvedValueOnce({
        response: '```json\n{"title": "Markdown Code Block", "summary": "JSON in markdown"}\n```',
      });

      const result = await llmService.processContent('Test content', 'note');

      // Check that JSON extraction still works
      expect(result).toHaveProperty('title', 'Markdown Code Block');
      expect(result).toHaveProperty('summary', 'JSON in markdown');
    });
  });
});
