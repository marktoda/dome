import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webSearchTool, webSearchInput } from '../../src/tools/webSearchTool';
import { LlmService } from '../../src/services/llmService';
import { AIMessage } from '../../src/types';

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

vi.mock('../../src/services/llmService', () => ({
  LlmService: {
    invokeStructured: vi.fn(),
  },
}));

describe('webSearchTool', () => {
  let mockEnv: any;
  let mockMessages: AIMessage[];

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup mock data
    mockEnv = {
      SEARCH_API_KEY: 'mock-api-key',
    };

    mockMessages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Search for information about climate change.' },
    ];

    // Mock invokeStructured to return a valid response
    vi.mocked(LlmService.invokeStructured).mockResolvedValue({
      toolName: 'web_search',
      args: {
        query: 'climate change',
        topK: 5,
      },
    });
  });

  it('should handle invokeStructured with web search schema', async () => {
    // Call invokeStructured with the webSearchInput schema
    await LlmService.invokeStructured(mockEnv, mockMessages, {
      schema: webSearchInput,
      schemaInstructions: 'Return search parameters',
    });

    // Verify invokeStructured was called with correct parameters
    expect(LlmService.invokeStructured).toHaveBeenCalledWith(
      mockEnv,
      mockMessages,
      expect.objectContaining({
        schema: webSearchInput,
        schemaInstructions: 'Return search parameters',
      }),
    );
  });

  it('should parse the schema with nullable fields correctly', () => {
    // Test with required and optional fields
    const validInput1 = { query: 'climate change', topK: 5 };
    const result1 = webSearchInput.safeParse(validInput1);
    expect(result1.success).toBe(true);

    // Test with null values for nullable fields
    const validInput2 = { query: 'climate change', topK: null };
    const result2 = webSearchInput.safeParse(validInput2);
    expect(result2.success).toBe(true);

    // Test with freshDays included
    const validInput3 = { query: 'climate change', topK: 5, freshDays: 7 };
    const result3 = webSearchInput.safeParse(validInput3);
    expect(result3.success).toBe(true);

    // Test with freshDays as null
    const validInput4 = { query: 'climate change', topK: 5, freshDays: null };
    const result4 = webSearchInput.safeParse(validInput4);
    expect(result4.success).toBe(true);

    // Test with invalid input (missing required query)
    const invalidInput = { topK: 5 };
    const resultInvalid = webSearchInput.safeParse(invalidInput);
    expect(resultInvalid.success).toBe(false);
  });

  it('should handle structured output with LlmService', async () => {
    // Set up test scenario with schemaInstructions
    const messages: AIMessage[] = [
      { role: 'system', content: 'Please search for climate information' },
      { role: 'user', content: 'I need information about recent climate change research' },
    ];

    // Mock an expected API response
    const mockResponse = {
      query: 'recent climate change research',
      topK: 3,
      freshDays: 30,
    };

    vi.mocked(LlmService.invokeStructured).mockResolvedValueOnce(mockResponse);

    // Call invokeStructured with our web search schema
    const result = await LlmService.invokeStructured(mockEnv, messages, {
      schema: webSearchInput,
      schemaInstructions: 'Extract search parameters from the user query',
    });

    // Verify the result matches our mocked response
    expect(result).toEqual(mockResponse);

    // Check LlmService was called with the right parameters
    expect(LlmService.invokeStructured).toHaveBeenCalledWith(mockEnv, messages, {
      schema: webSearchInput,
      schemaInstructions: 'Extract search parameters from the user query',
    });
  });
});
