import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmService } from '../src/services/llmService';
import * as schemas from '../src/schemas';

// Mock AI binding
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
  trackOperation: (op: string, fn: () => any, context?: Record<string, unknown>) => fn(),
  logError: vi.fn(),
}));

describe('Structured Invocation', () => {
  let llmService: LlmService;

  beforeEach(() => {
    vi.clearAllMocks();
    llmService = new LlmService(mockAi as any);
  });

  it('should handle successful schema-compliant responses', async () => {
    // Case 1: Clean JSON response
    mockAi.run.mockResolvedValueOnce({
      response: JSON.stringify({
        title: "Meeting Notes",
        summary: "Team meeting discussing Q3 goals.",
        todos: [
          { text: "Send follow-up email", priority: "high" },
          { text: "Update roadmap", priority: "medium" }
        ],
        topics: ["planning", "roadmap", "goals"]
      })
    });

    const result = await llmService.processContent("Meeting notes content", "note");
    
    expect(result).toHaveProperty('title', 'Meeting Notes');
    expect(result).toHaveProperty('summary', 'Team meeting discussing Q3 goals.');
    expect(result.todos).toHaveLength(2);
    expect(result.processingVersion).toBe(2);
  });

  it('should handle JSON response with markdown code blocks', async () => {
    // Case 2: JSON wrapped in markdown code blocks
    mockAi.run.mockResolvedValueOnce({
      response: `
\`\`\`json
{
  "title": "User Authentication Component",
  "summary": "React component for user authentication",
  "todos": [
    { "text": "Add error handling", "location": "handleSubmit()" }
  ],
  "components": ["LoginForm", "AuthContext"],
  "language": "JavaScript",
  "frameworks": ["React", "Firebase"],
  "topics": ["authentication", "frontend"]
}
\`\`\`
`
    });

    const result = await llmService.processContent("function handleSubmit() {...}", "code");
    
    expect(result).toHaveProperty('title', 'User Authentication Component');
    expect(result).toHaveProperty('language', 'JavaScript');
    expect(result.frameworks).toContain('React');
  });

  it('should handle cases when schema validation fails', async () => {
    // Set up schema validation to fail
    vi.spyOn(schemas.NoteProcessingSchema, 'parse').mockImplementationOnce(() => {
      throw new Error('Schema validation failed');
    });

    mockAi.run.mockResolvedValueOnce({
      response: `{"title": "Invalid Response"}`
    });

    const result = await llmService.processContent("Some content", "note");
    
    // Should fall back gracefully
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('summary', 'Content processing failed');
    expect(result).toHaveProperty('error');
    expect(result.processingVersion).toBe(2);
  });

  it('should handle LLM API errors gracefully', async () => {
    // Simulate LLM API error
    mockAi.run.mockRejectedValueOnce(new Error('LLM service unavailable'));

    const result = await llmService.processContent("Some content", "note");
    
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('summary', 'Content processing failed');
    expect(result).toHaveProperty('error', 'LLM service unavailable');
  });

  it('should generate appropriate fallback title', async () => {
    // Test the fallback title generation
    mockAi.run.mockRejectedValueOnce(new Error('API error'));

    const content = "First line as title\nSecond line content";
    const result = await llmService.processContent(content, "note");
    
    expect(result).toHaveProperty('title', 'First line as title');
  });
});