// @ts-nocheck
import { routingSplit } from './routingSplit';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState } from '../types';

// Mock dependencies
jest.mock('../services/llmService', () => ({
  LlmService: {
    invokeStructured: jest.fn()
  }
}));

jest.mock('../services/observabilityService', () => ({
  ObservabilityService: {
    initTrace: jest.fn().mockReturnValue('mock-trace-id'),
    startSpan: jest.fn().mockReturnValue('mock-span-id'),
    logEvent: jest.fn(),
    endSpan: jest.fn()
  }
}));

jest.mock('@dome/logging', () => ({
  getLogger: jest.fn().mockReturnValue({
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    })
  })
}));

describe('routingSplit node', () => {
  let mockState: AgentState;
  let mockEnv: Env;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock environment
    mockEnv = {
      ENVIRONMENT: 'test'
    } as Env;

    // Mock initial state
    mockState = {
      userId: 'test-user',
      messages: [
        { role: 'user', content: 'How do I bake a cake and also check the weather?', timestamp: Date.now() }
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000
      },
      metadata: {},
      tasks: {}
    } as AgentState;

    // Mock LLM response
    (LlmService.invokeStructured as jest.Mock).mockResolvedValue({
      tasks: [
        { id: 'task-1', query: 'How do I bake a cake?' },
        { id: 'task-2', query: 'What is the current weather?' }
      ],
      instructions: 'Respond to both culinary and weather questions.',
      reasoning: 'User asked about cake recipes and weather information. Split into separate tasks for better handling.'
    });
  });

  it('should extract tasks from user query and create task entities', async () => {
    // Execute node
    const result = await routingSplit(mockState, mockEnv);

    // Verify LLM was called with correct parameters
    expect(LlmService.invokeStructured).toHaveBeenCalledWith(
      mockEnv,
      expect.arrayContaining([
        { role: 'system', content: 'ROUTING_SPLIT_PROMPT' },
        { role: 'user', content: 'How do I bake a cake and also check the weather?' }
      ]),
      expect.objectContaining({
        schema: expect.any(Object)
      })
    );

    // Verify task entities were created
    expect(result.taskEntities).toBeDefined();
    expect(Object.keys(result.taskEntities || {})).toHaveLength(2);
    expect(result.taskEntities?.['task-1']).toEqual(expect.objectContaining({
      id: 'task-1',
      originalQuery: 'How do I bake a cake?',
      status: 'pending'
    }));
    expect(result.taskEntities?.['task-2']).toEqual(expect.objectContaining({
      id: 'task-2',
      originalQuery: 'What is the current weather?',
      status: 'pending'
    }));

    // Verify instructions and reasoning were added
    expect(result.instructions).toBe('Respond to both culinary and weather questions.');
    expect(result.reasoning).toContain('User asked about cake recipes and weather information.');
    
    // Verify observability calls
    expect(ObservabilityService.initTrace).toHaveBeenCalled();
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
  });

  it('should handle errors gracefully', async () => {
    // Mock LLM failure
    (LlmService.invokeStructured as jest.Mock).mockRejectedValue(new Error('Service unavailable'));

    // Execute node
    const result = await routingSplit(mockState, mockEnv);

    // Verify error handling
    expect(result.metadata.errors).toBeDefined();
    expect(result.metadata.errors?.[0].node).toBe('routingSplit');
    expect(result.metadata.errors?.[0].message).toBe('Service unavailable');
    expect(result.reasoning).toContain('Error processing query');
  });

  it('should handle empty message array', async () => {
    // Create state with no messages
    const emptyState = {
      ...mockState,
      messages: []
    };

    // Execute node
    const result = await routingSplit(emptyState, mockEnv);

    // Verify handling of missing user message
    expect(result.reasoning).toContain('No user message found');
    expect(LlmService.invokeStructured).not.toHaveBeenCalled();
  });
});