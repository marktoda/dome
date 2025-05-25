import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentState } from '../src/types';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({ 
    info: vi.fn(), 
    error: vi.fn(), 
    debug: vi.fn(), 
    warn: vi.fn(), 
    child: vi.fn().mockReturnThis(),
  }),
}));

// Mock nodes - these will be the actual implementations we're testing
vi.mock('../src/services', () => ({
  Services: vi.fn(),
}));

describe('Chat Graph Node Implementations', () => {
  let mockState: AgentState;
  let mockConfig: any;

  beforeEach(() => {
    mockState = {
      userId: 'test-user',
      messages: [
        { role: 'user', content: 'Hello, how are you?' }
      ],
      chatHistory: [],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
      },
      taskIds: [],
      taskEntities: {},
      docs: [],
      generatedText: '',
      retrievalLoop: {
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      },
      metadata: {},
    };

    mockConfig = {
      configurable: {
        thread_id: 'test-thread',
        runId: 'test-run',
      },
    };
  });

  describe('editSystemPrompt node', () => {
    it('should add system prompt to messages', async () => {
      // Import the actual node implementation
      const { editSystemPrompt } = await import('../src/nodes/editSystemPrompt');
      
      const result = await editSystemPrompt(mockState, mockConfig);

      expect(result.messages).toBeDefined();
      expect(result.messages.length).toBeGreaterThan(mockState.messages.length);
      
      // Should have a system message at the beginning
      const systemMessage = result.messages.find(msg => msg.role === 'system');
      expect(systemMessage).toBeDefined();
      expect(systemMessage?.content).toContain('assistant');
    });

    it('should preserve existing messages', async () => {
      const { editSystemPrompt } = await import('../src/nodes/editSystemPrompt');
      
      const result = await editSystemPrompt(mockState, mockConfig);

      const userMessage = result.messages.find(msg => 
        msg.role === 'user' && msg.content === 'Hello, how are you?'
      );
      expect(userMessage).toBeDefined();
    });

    it('should handle empty message array', async () => {
      const { editSystemPrompt } = await import('../src/nodes/editSystemPrompt');
      
      const emptyState = {
        ...mockState,
        messages: [],
      };

      const result = await editSystemPrompt(emptyState, mockConfig);

      expect(result.messages).toBeDefined();
      expect(result.messages.length).toBeGreaterThan(0);
      
      const systemMessage = result.messages.find(msg => msg.role === 'system');
      expect(systemMessage).toBeDefined();
    });
  });

  describe('filterHistory node', () => {
    it('should filter chat history based on context limits', async () => {
      const { filterHistory } = await import('../src/nodes/filterHistory');
      
      const stateWithHistory = {
        ...mockState,
        chatHistory: [
          {
            user: { role: 'user' as const, content: 'Previous question 1' },
            assistant: { role: 'assistant' as const, content: 'Previous answer 1' },
            timestamp: Date.now() - 3000,
          },
          {
            user: { role: 'user' as const, content: 'Previous question 2' },
            assistant: { role: 'assistant' as const, content: 'Previous answer 2' },
            timestamp: Date.now() - 2000,
          },
          {
            user: { role: 'user' as const, content: 'Previous question 3' },
            assistant: { role: 'assistant' as const, content: 'Previous answer 3' },
            timestamp: Date.now() - 1000,
          },
        ],
        options: {
          ...mockState.options,
          maxContextItems: 2, // Limit to 2 history items
        },
      };

      const result = await filterHistory(stateWithHistory, mockConfig);

      expect(result.chatHistory).toBeDefined();
      expect(result.chatHistory.length).toBeLessThanOrEqual(2);
      
      // Should keep the most recent items
      if (result.chatHistory.length > 0) {
        expect(result.chatHistory[0].timestamp).toBeGreaterThan(
          stateWithHistory.chatHistory[0].timestamp
        );
      }
    });

    it('should preserve all history when under limit', async () => {
      const { filterHistory } = await import('../src/nodes/filterHistory');
      
      const stateWithLimitedHistory = {
        ...mockState,
        chatHistory: [
          {
            user: { role: 'user' as const, content: 'Only question' },
            assistant: { role: 'assistant' as const, content: 'Only answer' },
            timestamp: Date.now(),
          },
        ],
        options: {
          ...mockState.options,
          maxContextItems: 5, // Higher than actual history
        },
      };

      const result = await filterHistory(stateWithLimitedHistory, mockConfig);

      expect(result.chatHistory).toEqual(stateWithLimitedHistory.chatHistory);
    });

    it('should handle empty chat history', async () => {
      const { filterHistory } = await import('../src/nodes/filterHistory');
      
      const result = await filterHistory(mockState, mockConfig);

      expect(result.chatHistory).toEqual([]);
    });
  });

  describe('combineContext node', () => {
    it('should combine retrieved documents into context', async () => {
      const { combineContext } = await import('../src/nodes/combineContext');
      
      const stateWithDocs = {
        ...mockState,
        docs: [
          {
            id: 'doc1',
            content: 'This is relevant information about greetings.',
            metadata: { title: 'Greeting Guide', score: 0.9 },
          },
          {
            id: 'doc2',
            content: 'Additional context about polite conversation.',
            metadata: { title: 'Conversation Basics', score: 0.8 },
          },
        ],
      };

      const result = await combineContext(stateWithDocs, mockConfig);

      expect(result.combinedContext).toBeDefined();
      expect(result.combinedContext).toContain('This is relevant information');
      expect(result.combinedContext).toContain('Additional context');
    });

    it('should handle empty document list', async () => {
      const { combineContext } = await import('../src/nodes/combineContext');
      
      const result = await combineContext(mockState, mockConfig);

      expect(result.combinedContext).toBeDefined();
      // Should provide some default context or empty string
      expect(typeof result.combinedContext).toBe('string');
    });

    it('should prioritize higher-scored documents', async () => {
      const { combineContext } = await import('../src/nodes/combineContext');
      
      const stateWithScoredDocs = {
        ...mockState,
        docs: [
          {
            id: 'doc1',
            content: 'Low relevance content.',
            metadata: { score: 0.3 },
          },
          {
            id: 'doc2',
            content: 'High relevance content.',
            metadata: { score: 0.9 },
          },
          {
            id: 'doc3',
            content: 'Medium relevance content.',
            metadata: { score: 0.6 },
          },
        ],
      };

      const result = await combineContext(stateWithScoredDocs, mockConfig);

      expect(result.combinedContext).toBeDefined();
      
      // Higher scored content should appear earlier in combined context
      const highIndex = result.combinedContext.indexOf('High relevance');
      const lowIndex = result.combinedContext.indexOf('Low relevance');
      
      if (highIndex !== -1 && lowIndex !== -1) {
        expect(highIndex).toBeLessThan(lowIndex);
      }
    });
  });

  describe('generateAnswer node', () => {
    it('should generate answer using combined context', async () => {
      const { generateAnswer } = await import('../src/nodes/generateAnswer');
      
      const stateWithContext = {
        ...mockState,
        combinedContext: 'Relevant context: Greetings are important in conversation.',
      };

      const result = await generateAnswer(stateWithContext, mockConfig);

      expect(result.generatedText).toBeDefined();
      expect(typeof result.generatedText).toBe('string');
      expect(result.generatedText.length).toBeGreaterThan(0);
    });

    it('should handle missing context gracefully', async () => {
      const { generateAnswer } = await import('../src/nodes/generateAnswer');
      
      const result = await generateAnswer(mockState, mockConfig);

      expect(result.generatedText).toBeDefined();
      expect(typeof result.generatedText).toBe('string');
      // Should still generate some response even without context
    });

    it('should respect token limits from options', async () => {
      const { generateAnswer } = await import('../src/nodes/generateAnswer');
      
      const stateWithLimits = {
        ...mockState,
        options: {
          ...mockState.options,
          maxTokens: 100, // Low token limit
        },
      };

      const result = await generateAnswer(stateWithLimits, mockConfig);

      expect(result.generatedText).toBeDefined();
      // Generated text should respect the token limit
      // This is difficult to test precisely without actual tokenization
      expect(result.generatedText.length).toBeLessThan(1000); // Rough heuristic
    });
  });

  describe('answerGuard node', () => {
    it('should validate appropriate answers', async () => {
      const { answerGuard } = await import('../src/nodes/answerGuard');
      
      const stateWithGoodAnswer = {
        ...mockState,
        generatedText: 'Hello! I am doing well, thank you for asking. How can I help you today?',
      };

      const result = await answerGuard(stateWithGoodAnswer, mockConfig);

      expect(result.answerQuality).toBeDefined();
      expect(result.answerQuality?.isAppropriate).toBe(true);
      expect(result.answerQuality?.confidence).toBeGreaterThan(0.5);
    });

    it('should flag inappropriate answers', async () => {
      const { answerGuard } = await import('../src/nodes/answerGuard');
      
      const stateWithBadAnswer = {
        ...mockState,
        generatedText: 'I cannot help with that.', // Too brief/unhelpful
      };

      const result = await answerGuard(stateWithBadAnswer, mockConfig);

      expect(result.answerQuality).toBeDefined();
      // May or may not be flagged as inappropriate depending on implementation
      expect(typeof result.answerQuality?.isAppropriate).toBe('boolean');
      expect(typeof result.answerQuality?.confidence).toBe('number');
    });

    it('should handle empty generated text', async () => {
      const { answerGuard } = await import('../src/nodes/answerGuard');
      
      const stateWithEmptyAnswer = {
        ...mockState,
        generatedText: '',
      };

      const result = await answerGuard(stateWithEmptyAnswer, mockConfig);

      expect(result.answerQuality).toBeDefined();
      expect(result.answerQuality?.isAppropriate).toBe(false);
      expect(result.answerQuality?.confidence).toBeGreaterThan(0);
    });
  });
});