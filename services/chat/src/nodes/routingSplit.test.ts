// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routingSplit } from './routingSplit';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState } from '../types';

// Mock dependencies
vi.mock('../services/llmService', () => ({
  LlmService: {
    invokeStructured: vi.fn()
  }
}));

vi.mock('../services/observabilityService', () => ({
  ObservabilityService: {
    initTrace: vi.fn().mockReturnValue('mock-trace-id'),
    startSpan: vi.fn().mockReturnValue('mock-span-id'),
    logEvent: vi.fn(),
    endSpan: vi.fn()
  }
}));

vi.mock('@dome/common', () => ({
  getLogger: vi.fn(() => ({
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }))
  })),
  logError: vi.fn(),
}));

// Mock crypto.randomUUID instead of replacing the entire crypto object
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => '123e4567-e89b-12d3-a456-426614174000');

describe('routingSplit node', () => {
  let mockState: AgentState;
  let mockEnv: Env;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock environment
    mockEnv = {
      ENVIRONMENT: 'test'
    } as Cloudflare.Env;

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
    vi.mocked(LlmService.invokeStructured).mockResolvedValue({
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
      expect.any(Array),
      expect.any(Object)
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
    // The implementation uses the reasoning from the LLM response directly
    // Check if reasoning array includes the LLM's reasoning string
    expect(result.reasoning).toEqual(
      expect.arrayContaining([
        'User asked about cake recipes and weather information. Split into separate tasks for better handling.'
      ])
    );
    
    // Verify observability calls
    expect(ObservabilityService.initTrace).toHaveBeenCalled();
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
  });

  it('should handle errors gracefully', async () => {
    // Mock LLM failure
    vi.mocked(LlmService.invokeStructured).mockRejectedValue(new Error('Service unavailable'));

    // Execute node
    const result = await routingSplit(mockState, mockEnv);

    // Verify error handling
    expect(result.metadata.errors).toBeDefined();
    expect(result.metadata.errors?.[0].node).toBe('routingSplit');
    expect(result.metadata.errors?.[0].message).toContain('Service unavailable');
    // The implementation adds an error message with "Error processing query: "
    // but it may have an extra prefix in the actual implementation
    expect(result.reasoning).toContain('Error processing query: Service unavailable');
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
    expect(result.reasoning[0]).toEqual('No user message found to process.');
    expect(LlmService.invokeStructured).not.toHaveBeenCalled();
  });
});
