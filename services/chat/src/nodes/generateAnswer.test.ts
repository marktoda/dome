import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateAnswer } from './generateAnswer';
import { ModelFactory } from '../services/modelFactory';
import { ObservabilityService } from '../services/observabilityService';
import { reduceRagContext } from '../utils/ragUtils';
import { AgentState, Document } from '../types';

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
vi.mock('../utils/ragUtils');

// Mock performance API
global.performance = {
  now: vi.fn(() => 123456),
} as any;

// Mock crypto for UUID generation
global.crypto = {
  randomUUID: vi.fn(() => 'mock-uuid-123'),
} as any;

describe('generateAnswer Node', () => {
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
        { role: 'user', content: 'What do you know about quantum computing?' }
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      docs: [
        {
          id: 'doc1',
          title: 'Introduction to Quantum Computing',
          body: 'Quantum computing is a type of computation that harnesses quantum mechanics...',
          metadata: {
            source: 'quantum-docs',
            createdAt: '2025-01-01',
            relevanceScore: 0.95,
            tokenCount: 150,
          }
        },
        {
          id: 'doc2',
          title: 'Quantum Algorithms',
          body: 'Quantum algorithms can solve certain problems faster than classical algorithms...',
          metadata: {
            source: 'quantum-docs',
            createdAt: '2025-01-02',
            relevanceScore: 0.85,
            tokenCount: 120,
          }
        }
      ],
      taskIds: ['task-1'],
      taskEntities: {
        'task-1': {
          id: 'task-1',
          toolResults: []
        }
      },
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
      text: 'Quantum computing leverages quantum mechanics principles to process information...'
    };
    
    mockStreamResponse = {
      [Symbol.asyncIterator]: vi.fn().mockImplementation(() => {
        return {
          next: vi.fn()
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'Quantum ' } 
            })
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'computing ' } 
            })
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'leverages ' } 
            })
            .mockResolvedValueOnce({ 
              done: false, 
              value: { content: 'quantum mechanics... [1]' } 
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
    
    // Mock reduceRagContext
    vi.mocked(reduceRagContext).mockReturnValue({
      docs: mockState.docs as Document[],
      tokenCount: 270
    });
  });

  it('should transform state with RAG-enabled answer generation', async () => {
    // Execute the node
    const result = await generateAnswer(mockState, mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();
    expect(result.metadata).toMatchObject({
      currentNode: 'generate_rag',
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
    
    // Verify reduceRagContext was called
    expect(reduceRagContext).toHaveBeenCalledWith(
      mockState,
      expect.any(Number)
    );
    
    // Verify observability service was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
    expect(ObservabilityService.endTrace).toHaveBeenCalled();
  });

  it('should handle streaming when LangGraph stream configuration is provided', async () => {
    // Execute the node with streaming config
    await generateAnswer(mockState, mockConfig, mockEnv);
    
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
        langgraph_node: 'generate_rag',
        traceId: 'trace-123',
        spanId: 'span-123'
      })
    }));
  });

  it('should handle non-streaming fallback when no stream configuration is provided', async () => {
    // Modify config to not include stream
    const nonStreamConfig = { configurable: {} };
    
    // Execute the node
    const result = await generateAnswer(mockState, nonStreamConfig, mockEnv);
    
    // Verify result still contains generated text
    expect(result.generatedText).toBeDefined();
    expect(result.generatedText).toBe(mockLlmResponse.text);
    
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
    const result = await generateAnswer(mockState, mockConfig, mockEnv);
    
    // Should still return a result with an error message
    expect(result.generatedText).toContain('I apologize');
    expect(result.metadata?.isFinalState).toBe(true);
  });
});