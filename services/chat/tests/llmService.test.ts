import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMService } from '../src/services/llmService';
import { createServiceMetrics } from '@dome/common';

// Mock external dependencies
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn(),
    stream: vi.fn(),
    bindTools: vi.fn(),
  })),
}));

vi.mock('../src/services/modelFactory', () => ({
  ModelFactory: {
    createModel: vi.fn().mockReturnValue({
      invoke: vi.fn(),
      stream: vi.fn(),
      bindTools: vi.fn(),
    }),
  },
}));

vi.mock('../src/config', () => ({
  getTimeoutConfig: vi.fn().mockReturnValue({
    llmServiceTimeout: 30000,
  }),
}));

describe('LLMService', () => {
  let mockEnv: any;
  let llmService: LLMService;

  beforeEach(() => {
    mockEnv = {
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: 'test-key',
    };
    llmService = new LLMService(mockEnv);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create LLMService instance', () => {
      expect(llmService).toBeInstanceOf(LLMService);
    });

    it('should have required environment variables', () => {
      expect(mockEnv.OPENAI_API_KEY).toBeDefined();
    });
  });

  describe('generateResponse', () => {
    it('should handle successful response generation', async () => {
      const mockModel = {
        invoke: vi.fn().mockResolvedValue({
          content: 'Test response',
        }),
      };

      vi.mocked(llmService.createModel as any) = vi.fn().mockReturnValue(mockModel);

      const messages = [{ role: 'user', content: 'Test message' }];
      const result = await llmService.generateResponse(messages);

      expect(result).toBeDefined();
      expect(mockModel.invoke).toHaveBeenCalledWith(expect.any(Array));
    });

    it('should handle timeout errors', async () => {
      const mockModel = {
        invoke: vi.fn().mockImplementation(() => 
          new Promise((resolve) => setTimeout(resolve, 35000))
        ),
      };

      vi.mocked(llmService.createModel as any) = vi.fn().mockReturnValue(mockModel);

      const messages = [{ role: 'user', content: 'Test message' }];
      
      await expect(llmService.generateResponse(messages, { timeout: 1000 }))
        .rejects.toThrow('LLM call timed out');
    });

    it('should handle model errors gracefully', async () => {
      const mockModel = {
        invoke: vi.fn().mockRejectedValue(new Error('Model error')),
      };

      vi.mocked(llmService.createModel as any) = vi.fn().mockReturnValue(mockModel);

      const messages = [{ role: 'user', content: 'Test message' }];
      
      await expect(llmService.generateResponse(messages))
        .rejects.toThrow('Model error');
    });
  });

  describe('streaming responses', () => {
    it('should handle streaming response generation', async () => {
      const mockModel = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { content: 'Part 1' };
            yield { content: 'Part 2' };
          },
        }),
      };

      vi.mocked(llmService.createModel as any) = vi.fn().mockReturnValue(mockModel);

      const messages = [{ role: 'user', content: 'Test message' }];
      const stream = await llmService.generateStreamingResponse(messages);

      expect(stream).toBeDefined();
      expect(mockModel.stream).toHaveBeenCalledWith(expect.any(Array));
    });
  });

  describe('tool usage', () => {
    it('should handle tool binding and execution', async () => {
      const mockTool = {
        name: 'test-tool',
        description: 'Test tool',
        schema: {},
      };

      const mockModel = {
        bindTools: vi.fn().mockReturnValue({
          invoke: vi.fn().mockResolvedValue({
            content: 'Tool response',
            tool_calls: [{ name: 'test-tool', args: {} }],
          }),
        }),
      };

      vi.mocked(llmService.createModel as any) = vi.fn().mockReturnValue(mockModel);

      const messages = [{ role: 'user', content: 'Use test tool' }];
      const result = await llmService.generateResponseWithTools(messages, [mockTool]);

      expect(result).toBeDefined();
      expect(mockModel.bindTools).toHaveBeenCalledWith([mockTool]);
    });
  });
});