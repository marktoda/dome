import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmService } from '../src/services/llmService';

// Mock the AI binding
const mockAi = {
  run: vi.fn(),
};

// Mock the logger
vi.mock('@dome/logging', () => ({
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
  metrics: {
    increment: vi.fn(),
    timing: vi.fn(),
  },
}));

describe('LlmService', () => {
  let llmService: LlmService;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Create a new instance for each test
    llmService = new LlmService(mockAi as any);
    
    // Default mock implementation for AI.run
    mockAi.run.mockResolvedValue({
      response: JSON.stringify({
        title: 'Test Title',
        summary: 'Test summary.',
        todos: [{ text: 'Test todo', priority: 'high' }],
        topics: ['test', 'example'],
      }),
    });
  });

  describe('processContent', () => {
    it('should process note content correctly', async () => {
      const content = 'This is a test note.\nTODO: Finish the test';
      const result = await llmService.processContent(content, 'note');
      
      // Check that AI was called with the right model
      expect(mockAi.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', expect.anything());
      
      // Check that the result contains expected fields
      expect(result).toHaveProperty('title', 'Test Title');
      expect(result).toHaveProperty('summary', 'Test summary.');
      expect(result).toHaveProperty('todos');
      expect(result).toHaveProperty('processingVersion', 1);
      expect(result).toHaveProperty('modelUsed', '@cf/meta/llama-3-8b-instruct');
    });

    it('should process code content correctly', async () => {
      const content = '// TODO: Implement this function\nfunction test() { return true; }';
      const result = await llmService.processContent(content, 'code');
      
      // Check that AI was called with the right model
      expect(mockAi.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', expect.anything());
      
      // Check that the result contains expected fields
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('todos');
      expect(result).toHaveProperty('processingVersion');
    });

    it('should handle AI errors gracefully', async () => {
      // Mock AI to throw an error
      mockAi.run.mockRejectedValue(new Error('AI processing failed'));
      
      const content = 'This is a test note.';
      const result = await llmService.processContent(content, 'note');
      
      // Check that we get a fallback result
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('summary', 'Content processing failed');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('processingVersion', 1);
    });

    it('should handle parsing errors gracefully', async () => {
      // Mock AI to return invalid JSON
      mockAi.run.mockResolvedValue({
        response: 'This is not valid JSON',
      });
      
      const content = 'This is a test note.';
      const result = await llmService.processContent(content, 'note');
      
      // Check that we get a fallback result
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('error', 'Response parsing failed');
    });

    it('should truncate long content', async () => {
      // Create a very long content string
      const longContent = 'A'.repeat(10000);
      await llmService.processContent(longContent, 'note');
      
      // Check that the content was truncated in the prompt
      const aiCallArgs = mockAi.run.mock.calls[0][1];
      expect(aiCallArgs.messages[0].content.length).toBeLessThan(10000);
      expect(aiCallArgs.messages[0].content).toContain('[Content truncated');
    });
  });
});