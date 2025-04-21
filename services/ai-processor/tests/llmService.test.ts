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

      // Check that the prompt contains note-specific instructions
      const prompt = mockAi.run.mock.calls[0][1].messages[0].content;
      expect(prompt).toContain('Analyze the following note');
      expect(prompt).toContain('concise title');
      expect(prompt).toContain('TODOs mentioned');
      expect(prompt).toContain('reminders mentioned');

      // Check that the result contains expected fields
      expect(result).toHaveProperty('title', 'Test Title');
      expect(result).toHaveProperty('summary', 'Test summary.');
      expect(result).toHaveProperty('todos');
      expect(result.todos).toHaveLength(1);
      expect(result.todos[0]).toHaveProperty('text', 'Test todo');
      expect(result.todos[0]).toHaveProperty('priority', 'high');
      expect(result).toHaveProperty('topics');
      expect(result.topics).toEqual(['test', 'example']);
      expect(result).toHaveProperty('processingVersion', 1);
      expect(result).toHaveProperty('modelUsed', '@cf/meta/llama-3-8b-instruct');
    });

    it('should process code content correctly', async () => {
      // Mock AI to return code-specific response
      mockAi.run.mockResolvedValue({
        response: JSON.stringify({
          title: 'Test Function',
          summary: 'A test function that returns true.',
          todos: [{ text: 'Implement this function', location: 'Line 1' }],
          components: ['test()'],
          language: 'JavaScript',
          frameworks: [],
          topics: ['testing', 'functions'],
        }),
      });

      const content = '// TODO: Implement this function\nfunction test() { return true; }';
      const result = await llmService.processContent(content, 'code');

      // Check that AI was called with the right model
      expect(mockAi.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', expect.anything());

      // Check that the prompt contains code-specific instructions
      const prompt = mockAi.run.mock.calls[0][1].messages[0].content;
      expect(prompt).toContain('Analyze the following code');
      expect(prompt).toContain('TODOs in comments');
      expect(prompt).toContain('functions/classes/components');
      expect(prompt).toContain('Programming language');

      // Check that the result contains expected fields
      expect(result).toHaveProperty('title', 'Test Function');
      expect(result).toHaveProperty('summary', 'A test function that returns true.');
      expect(result).toHaveProperty('todos');
      expect(result.todos[0]).toHaveProperty('location', 'Line 1');
      expect(result).toHaveProperty('components', ['test()']);
      expect(result).toHaveProperty('language', 'JavaScript');
      expect(result).toHaveProperty('topics', ['testing', 'functions']);
      expect(result).toHaveProperty('processingVersion', 1);
    });

    it('should process article content correctly', async () => {
      // Mock AI to return article-specific response
      mockAi.run.mockResolvedValue({
        response: JSON.stringify({
          title: 'Test Article',
          summary: 'This is a test article about testing.',
          keyPoints: ['Point 1', 'Point 2'],
          topics: ['testing', 'articles'],
          entities: {
            people: ['John Doe'],
            organizations: ['Test Org'],
            products: ['Test Product'],
          },
        }),
      });

      const content =
        'This is a test article.\nIt talks about testing.\nWritten by John Doe from Test Org.';
      const result = await llmService.processContent(content, 'article');

      // Check that the prompt contains article-specific instructions
      const prompt = mockAi.run.mock.calls[0][1].messages[0].content;
      expect(prompt).toContain('Analyze the following article');
      expect(prompt).toContain('Key points or takeaways');
      expect(prompt).toContain('Entities mentioned');

      // Check that the result contains expected fields
      expect(result).toHaveProperty('title', 'Test Article');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('keyPoints');
      expect(result).toHaveProperty('entities');
      expect(result.entities).toHaveProperty('people', ['John Doe']);
      expect(result.entities).toHaveProperty('organizations', ['Test Org']);
    });

    it('should handle AI errors gracefully', async () => {
      // Mock AI to throw an error
      mockAi.run.mockRejectedValue(new Error('AI processing failed'));

      const content = 'This is a test note.';
      const result = await llmService.processContent(content, 'note');

      // Check that we get a fallback result
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('summary', 'Content processing failed');
      expect(result).toHaveProperty('error', 'AI processing failed');
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

    it('should handle partial JSON responses', async () => {
      // Mock AI to return JSON embedded in text
      mockAi.run.mockResolvedValue({
        response:
          'Here is the analysis:\n\n{"title": "Embedded JSON", "summary": "This is embedded in text."}\n\nHope this helps!',
      });

      const content = 'This is a test note.';
      const result = await llmService.processContent(content, 'note');

      // Check that we extracted the JSON correctly
      expect(result).toHaveProperty('title', 'Embedded JSON');
      expect(result).toHaveProperty('summary', 'This is embedded in text.');
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

    it('should use default prompt for unknown content types', async () => {
      const content = 'This is some content with unknown type.';
      await llmService.processContent(content, 'unknown-type');

      // Check that the default prompt was used
      const prompt = mockAi.run.mock.calls[0][1].messages[0].content;
      expect(prompt).toContain('Analyze the following content');
      expect(prompt).not.toContain('Analyze the following note');
      expect(prompt).not.toContain('Analyze the following code');
      expect(prompt).not.toContain('Analyze the following article');
    });

    it('should generate a fallback title from the first line', async () => {
      // Mock the AI to throw an error to trigger fallback
      mockAi.run.mockRejectedValue(new Error('AI error'));

      const content = 'First line as title\nSecond line\nThird line';
      const result = await llmService.processContent(content, 'note');

      // Check that the first line was used as title
      expect(result).toHaveProperty('title', 'First line as title');
    });

    it('should truncate long first lines for fallback titles', async () => {
      // Mock the AI to throw an error to trigger fallback
      mockAi.run.mockRejectedValue(new Error('AI error'));

      const longFirstLine = 'A'.repeat(100);
      const content = `${longFirstLine}\nSecond line`;
      const result = await llmService.processContent(content, 'note');

      // Check that the title was truncated
      expect(result.title.length).toBeLessThan(longFirstLine.length);
      expect(result.title).toContain('...');
    });
  });
});
