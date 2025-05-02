import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateChatLLM } from './generateChatLLM';
import { ModelFactory } from '../services/modelFactory';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState } from '../types';

// Mock dependencies
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  })),
  logError: vi.fn(),
}));

vi.mock('../services/modelFactory');
vi.mock('../services/observabilityService');

// Mock performance API
global.performance = {
  now: vi.fn(() => 123456),
} as any;

// Mock crypto.randomUUID instead of replacing the entire crypto object
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => '123e4567-e89b-12d3-a456-426614174000');

describe('generateChatLLM Node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockConfig: any;
  let mockLlmResponse: any;
  let mockStreamResponse: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup mock data
    mockState = {
      userId: 'user-123',
      messages: [
        { role: 'user', content: 'What is machine learning?' }
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      taskIds: [], // Empty task IDs array
      taskEntities: {}, // Empty task entities object
      metadata: {
        traceId: 'trace-123',
      }
    };
    
    mockEnv = { 
      OPENAI_API_KEY: 'mock-api-key',
    };
    
    mockConfig = {
      configurable: {
        stream: {
          handleChunk: vi.fn().mockResolvedValue(undefined),
        }
      }
    };
    
    mockLlmResponse = {
      text: 'Machine learning is a subset of artificial intelligence...'
    };
    
    mockStreamResponse = {
      [Symbol.asyncIterator]: vi.fn().mockImplementation(() => {
        return {
          next: vi.fn()
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'Machine ' } 
            })
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'learning ' } 
            })
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'is a subset ' } 
            })
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'of artificial intelligence...' } 
            })
            .mockResolvedValueOnce({ 
              done: true, 
              value: undefined 
            })
        };
      })
    };
    
    // Mock model factory
    vi.mocked(ModelFactory.createChatModel).mockReturnValue({
      invoke: vi.fn().mockResolvedValue(mockLlmResponse),
      stream: vi.fn().mockResolvedValue(mockStreamResponse),
    } as any);
    
    // Mock observability service
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('span-123');
    vi.mocked(ObservabilityService.logEvent).mockReturnValue(undefined);
  });

  it('should transform state with simple chat answer generation', async () => {
    // Execute the node
    const result = await generateChatLLM(mockState, mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result?.generatedText).toBeDefined();
    expect(result?.metadata).toMatchObject({
      currentNode: 'generate_chat_llm',
      isFinalState: true,
      executionTimeMs: expect.any(Number),
    });
    
    // Verify model factory was called with correct parameters
    expect(ModelFactory.createChatModel).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        modelId: expect.any(String),
        temperature: expect.any(Number),
        streaming: true
      })
    );
    
    // Verify observability service was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
    expect(ObservabilityService.endTrace).toHaveBeenCalled();
  });

  it('should handle streaming when LangGraph stream configuration is provided', async () => {
    // Execute the node with streaming config
    await generateChatLLM(mockState, mockConfig, mockEnv);
    
    // Verify the stream handler was called for each chunk
    const handleChunk = mockConfig.configurable.stream.handleChunk;
    
    // Should be called 4 times (for each chunk)
    expect(handleChunk).toHaveBeenCalledTimes(4);
    
    // Check the format of a sample call
    expect(handleChunk).toHaveBeenCalledWith(expect.objectContaining({
      event: 'on_chat_model_stream',
      data: expect.objectContaining({
        chunk: expect.any(Object)
      }),
      metadata: expect.objectContaining({
        langgraph_node: 'generate_chat_llm',
        traceId: 'trace-123',
        spanId: 'span-123'
      })
    }));
  });

  it('should handle non-streaming fallback when no stream configuration is provided', async () => {
    // Modify config to not include stream
    const nonStreamConfig = { configurable: {} };
    
    // Execute the node
    const result = await generateChatLLM(mockState, nonStreamConfig, mockEnv);
    
    // Verify result still contains generated text
    expect(result?.generatedText).toBeDefined();
    expect(result?.generatedText).toBe(mockLlmResponse.text);
    
    // No stream handling should occur
    const handleChunk = mockConfig.configurable.stream.handleChunk;
    expect(handleChunk).not.toHaveBeenCalled();
  });

  it('should gracefully handle errors in LLM call', async () => {
    // Make the model throw an error
    vi.mocked(ModelFactory.createChatModel).mockReturnValue({
      invoke: vi.fn().mockRejectedValue(new Error('LLM error')),
      stream: vi.fn().mockRejectedValue(new Error('LLM error')),
    } as any);
    
    // Execute the node
    const result = await generateChatLLM(mockState, mockConfig, mockEnv);
    
    // Should still return a result with an error message
    expect(result?.generatedText).toContain('I apologize');
    expect(result?.metadata?.isFinalState).toBe(true);
  });
  
  it('should use correct system prompt for non-RAG chat', async () => {
    // Execute the node
    await generateChatLLM(mockState, mockConfig, mockEnv);
    
    // Get the mock calls to the model's stream method
    const streamCalls = vi.mocked(ModelFactory.createChatModel).mock.results[0].value.stream.mock.calls;
    
    // Expect there to be at least one call
    expect(streamCalls.length).toBeGreaterThan(0);
    
    // Get the first message in the first call, which should be the system message
    const systemMessage = streamCalls[0][0][0];
    
    // Verify it's a system message with appropriate content
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.content).toContain('You are an AI assistant designed to be helpful');
    expect(systemMessage.content).not.toContain('Context from user\'s knowledge base');
  });
});