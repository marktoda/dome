import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrievalSelector } from './retrievalSelector';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState, RetrievalTask, UserTaskEntity } from '../types';

// Mock dependencies
vi.mock('@dome/common', () => ({
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

vi.mock('../services/llmService');
vi.mock('../services/observabilityService');
vi.mock('../utils/errors', () => ({
  toDomeError: vi.fn((error) => ({
    message: error instanceof Error ? error.message : 'Unknown error',
    code: 'ERR_RETRIEVAL_SELECTOR',
  })),
}));

// Mock performance API
global.performance = {
  now: vi.fn()
    .mockReturnValueOnce(100) // Start time
    .mockReturnValueOnce(300), // End time (200ms elapsed)
} as any;

// Mock crypto.randomUUID instead of replacing the entire crypto object
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => '123e4567-e89b-12d3-a456-426614174000');

describe('retrievalSelector Node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockConfig: any;
  let mockLlmResponse: { tasks: RetrievalTask[], reasoning: string };

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup mock task entities
    const mockTaskEntities: Record<string, UserTaskEntity> = {
      'task-1': {
        id: 'task-1',
        definition: 'Implementation of binary search tree in Python',
        originalQuery: 'How do I implement a binary search tree in Python with code examples?',
        status: 'pending',
        createdAt: Date.now()
      },
      'task-2': {
        id: 'task-2',
        definition: 'Applications of binary search trees',
        originalQuery: 'What are the practical applications of binary search trees?',
        status: 'pending',
        createdAt: Date.now()
      }
    };
    
    mockState = {
      userId: 'user-123',
      messages: [
        { role: 'user', content: 'How do I implement a binary search tree in Python and what are the applications?' }
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      taskEntities: mockTaskEntities,
      taskIds: ['task-1', 'task-2'],
      metadata: {
        traceId: 'trace-123',
      }
    };
    
    mockEnv = { 
      OPENAI_API_KEY: 'mock-api-key',
    };
    
    mockConfig = {};
    
    // Setup mock LLM response with retrieval tasks
    mockLlmResponse = {
      tasks: [
        {
          category: 'code' as any,
          query: 'How do I implement a binary search tree in Python?'
        },
        {
          category: 'docs' as any,
          query: 'What are the practical applications of binary search trees?'
        }
      ],
      reasoning: 'Selected code repositories for implementation examples and documentation for understanding applications.'
    };
    
    // Mock LlmService.invokeStructured to return our mock response
    vi.mocked(LlmService.invokeStructured).mockResolvedValue(mockLlmResponse);
    
    // Mock ObservabilityService
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('span-123');
    vi.mocked(ObservabilityService.logEvent).mockReturnValue(undefined);
  });

  it('should select appropriate retrievers for each task', async () => {
    // Execute the node
    const result = await retrievalSelector(mockState, mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.retrievals).toBeDefined();
    
    // Check retrieval tasks match the LLM response
    expect(result.retrievals).toEqual(mockLlmResponse.tasks);
    
    // Verify reasoning was added
    expect(result.reasoning).toContain(mockLlmResponse.reasoning);
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'retrievalSelector',
      executionTimeMs: expect.any(Number),
    });
    
    // Verify LLM service was called
    expect(LlmService.invokeStructured).toHaveBeenCalledTimes(1);
    
    // Verify observability service was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
  });

  it('should handle state with no split tasks', async () => {
    // Set up state with no taskIds
    const stateWithoutTasks = {
      ...mockState,
      taskIds: [],
      taskEntities: {}
    };
    
    // Execute the node
    const result = await retrievalSelector(stateWithoutTasks, mockConfig, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'retrievalSelector',
      message: expect.any(String),
    });
    
    // Verify LLM service was not called
    expect(LlmService.invokeStructured).not.toHaveBeenCalled();
  });

  it('should handle state with empty tasks array', async () => {
    // Set up state with empty taskIds array
    const stateWithEmptyTasks = {
      ...mockState,
      taskIds: [],
      taskEntities: {}
    };
    
    // Execute the node
    const result = await retrievalSelector(stateWithEmptyTasks, mockConfig, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'retrievalSelector',
      message: expect.any(String),
    });
    
    // Verify LLM service was not called
    expect(LlmService.invokeStructured).not.toHaveBeenCalled();
  });

  it('should handle LLM errors gracefully', async () => {
    // Make the LLM service throw an error
    vi.mocked(LlmService.invokeStructured).mockReset();
    vi.mocked(LlmService.invokeStructured).mockRejectedValue(new Error('LLM API error'));
    
    // Execute the node
    const result = await retrievalSelector(mockState, mockConfig, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'retrievalSelector',
      message: 'LLM API error',
    });
  });
});
