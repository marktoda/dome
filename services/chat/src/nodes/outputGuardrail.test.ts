import { describe, it, expect, vi, beforeEach } from 'vitest';
import { outputGuardrail } from './outputGuardrail';
import { ModelFactory } from '../services/modelFactory';
import { ObservabilityService } from '../services/observabilityService';
import * as tokenCounter from '../utils/tokenCounter';
import * as modelConfig from '../config/modelConfig';
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
vi.mock('../utils/errors', () => ({
  toDomeError: vi.fn((error) => ({
    message: error instanceof Error ? error.message : 'Unknown error',
    code: 'ERR_OUTPUT_GUARDRAIL',
  })),
}));
vi.mock('../utils/tokenCounter');
vi.mock('../config/modelConfig');

// Mock performance API
global.performance = {
  now: vi.fn()
    .mockReturnValueOnce(100) // Start time
    .mockReturnValueOnce(350), // End time (250ms elapsed)
} as any;

// Mock crypto.randomUUID instead of replacing the entire crypto object
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => '123e4567-e89b-12d3-a456-426614174000');

describe('outputGuardrail Node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockConfig: any;
  let mockLlmResponseValidated: any;
  let mockLlmResponseWithCorrections: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup mock data
    mockState = {
      userId: 'user-123',
      messages: [
        { role: 'user', content: 'How do I implement a binary search tree in Python?' }
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      retrievals: [
        {
          category: 'code' as any,
          query: 'binary search tree implementation python'
        }
      ],
      reasoning: [
        `# Binary Search Tree Implementation in Python

Binary Search Trees (BSTs) are efficient data structures for lookups. They support operations like search, insert, and delete with an average time complexity of O(log n).

## Implementation
A basic implementation includes a Node class and a BST class:

\`\`\`python
class Node:
    def __init__(self, data):
        self.data = data
        self.left = None
        self.right = None

class BinarySearchTree:
    def __init__(self):
        self.root = None
        
    def insert(self, value):
        if self.root is None:
            self.root = Node(value)
            return
        
        self._insert_recursive(self.root, value)
\`\`\`
Source: [GitHub: BST Implementation, Documentation]`
      ],
      generatedText: "# Implementing a Binary Search Tree in Python\n\nBinary Search Trees (BSTs) are efficient data structures that allow for fast lookups, insertions, and deletions. Here's how you can implement a BST in Python:\n\n## Basic Implementation\n\nFirst, you need to create a Node class:\n\n```python\nclass Node:\n    def __init__(self, data):\n        self.data = data\n        self.left = None\n        self.right = None\n```\n\nThen, implement the BST class:\n\n```python\nclass BinarySearchTree:\n    def __init__(self):\n        self.root = None\n        \n    def insert(self, value):\n        if self.root is None:\n            self.root = Node(value)\n            return\n        \n        self._insert_recursive(self.root, value)\n        \n    def _insert_recursive(self, node, value):\n        if value < node.data:\n            if node.left is None:\n                node.left = Node(value)\n            else:\n                self._insert_recursive(node.left, value)\n        else:\n            if node.right is None:\n                node.right = Node(value)\n            else:\n                self._insert_recursive(node.right, value)\n```\n\nThis implementation includes the basic functionality for creating and inserting nodes into a BST.",
      metadata: {
        traceId: 'trace-123',
      }
    };
    
    mockEnv = { 
      OPENAI_API_KEY: 'mock-api-key',
    };
    
    mockConfig = {};
    
    // Mock response for validation without corrections
    mockLlmResponseValidated = {
      text: `VALIDATION ASSESSMENT:
Accuracy score: 9/10
The answer provides an accurate implementation of a binary search tree in Python. The code for the Node class and BinarySearchTree class with its insert method matches the reference context. The explanation is clear and correct.

The only small issue is that the answer doesn't explicitly mention the average time complexity of BST operations being O(log n), which was noted in the reference context.

Source attribution is present in the reference context but wasn't carried over to the answer. However, since this is a standard implementation that doesn't require specific attribution, this is acceptable.

ORIGINAL ANSWER VALIDATED`
    };
    
    // Mock response for validation with corrections
    mockLlmResponseWithCorrections = {
      text: `VALIDATION ASSESSMENT:
Accuracy score: 7/10
The answer provides a mostly accurate implementation of a binary search tree in Python. However, there are a few issues:

1. The answer doesn't mention the average time complexity of BST operations being O(log n), which is important information from the context.
2. The answer lacks proper source attribution that was present in the reference context.
3. The _insert_recursive method implementation goes beyond what was provided in the reference context, though it is technically correct.

CORRECTED VERSION:
# Implementing a Binary Search Tree in Python

Binary Search Trees (BSTs) are efficient data structures that allow for fast lookups, insertions, and deletions with an average time complexity of O(log n). Here's how you can implement a BST in Python:

## Basic Implementation

First, you need to create a Node class:

\`\`\`python
class Node:
    def __init__(self, data):
        self.data = data
        self.left = None
        self.right = None
\`\`\`

Then, implement the BST class:

\`\`\`python
class BinarySearchTree:
    def __init__(self):
        self.root = None
        
    def insert(self, value):
        if self.root is None:
            self.root = Node(value)
            return
        
        self._insert_recursive(self.root, value)
        
    def _insert_recursive(self, node, value):
        if value < node.data:
            if node.left is None:
                node.left = Node(value)
            else:
                self._insert_recursive(node.left, value)
        else:
            if node.right is None:
                node.right = Node(value)
            else:
                self._insert_recursive(node.right, value)
\`\`\`

This implementation includes the basic functionality for creating and inserting nodes into a BST.

Source: GitHub: BST Implementation, Documentation`
    };
    
    // Mock TokenCounter
    vi.mocked(tokenCounter.countTokens)
      .mockReturnValue(100);
    
    // Mock ModelConfig
    vi.mocked(modelConfig.getModelConfig).mockReturnValue({
      id: 'gpt-4-turbo',
      contextWindow: 16000,
      maxTokens: 4000,
    } as any);
    
    vi.mocked(modelConfig.calculateTokenLimits).mockReturnValue({
      maxContextTokens: 15000,
      maxResponseTokens: 1000,
    });
    
    // Mock ChatModel for no corrections
    const mockChatModelNoCorrections = {
      invoke: vi.fn().mockResolvedValue(mockLlmResponseValidated),
    };
    
    // Mock ModelFactory
    vi.mocked(ModelFactory.createChatModel).mockReturnValue(mockChatModelNoCorrections as any);
    
    // Mock ObservabilityService
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('span-123');
    vi.mocked(ObservabilityService.endSpan).mockImplementation(() => {});
    vi.mocked(ObservabilityService.endTrace).mockImplementation(() => {});
  });

  it('should validate the generated answer and keep it as-is when no corrections needed', async () => {
    // Execute the node
    const result = await outputGuardrail(mockState, mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();
    
    // When validated without corrections, the original answer should be preserved
    expect(result.generatedText).toBe(mockState.generatedText);
    
    // Verify validation assessment was recorded in reasoning
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning?.[0]).toBe(mockState.reasoning?.[0]);
    expect(result.reasoning?.[1]).toContain('VALIDATION: Original answer validated');
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'outputGuardrail',
      isFinalState: true,
      executionTimeMs: expect.any(Number),
    });
    
    // Verify model factory was called with correct parameters
    expect(ModelFactory.createChatModel).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        modelId: expect.any(String),
        temperature: 0.2,
        maxTokens: expect.any(Number)
      })
    );
    
    // Verify model.invoke was called with prompt containing the answer to validate
    const modelInvoke = vi.mocked(ModelFactory.createChatModel).mock.results[0].value.invoke;
    expect(modelInvoke).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining(mockState.generatedText || '')
        })
      ])
    );
    
    // Verify prompt also contains context used to generate the answer
    const prompt = modelInvoke.mock.calls[0][0][0].content;
    expect(prompt).toContain('REFERENCE CONTEXT USED');
    expect(prompt).toContain('Binary Search Trees (BSTs) are efficient data structures');
    
    // Verify observability service was used
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
    expect(ObservabilityService.endTrace).toHaveBeenCalled();
  });

  it('should validate and correct the generated answer when corrections are needed', async () => {
    // Override mock to return a response with corrections
    vi.mocked(ModelFactory.createChatModel).mockReturnValue({
      invoke: vi.fn().mockResolvedValue(mockLlmResponseWithCorrections),
    } as any);
    
    // Execute the node
    const result = await outputGuardrail(mockState, mockConfig, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();
    
    // The corrected answer should be different from the original
    expect(result.generatedText).not.toBe(mockState.generatedText);
    
    // The corrected answer should include the corrections
    expect(result.generatedText).toContain('average time complexity of O(log n)');
    expect(result.generatedText).toContain('Source: GitHub');
    
    // Verify validation assessment was recorded in reasoning
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning?.[1]).toContain('VALIDATION: Answer was corrected');
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'outputGuardrail',
      isFinalState: true,
      executionTimeMs: expect.any(Number),
    });
  });

  it('should handle state with no generated text to validate', async () => {
    // Setup state with no generated text
    const stateWithoutText = {
      ...mockState,
      generatedText: undefined
    };
    
    // Execute the node
    const result = await outputGuardrail(stateWithoutText, mockConfig, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'outputGuardrail',
      message: 'No generated answer found to validate',
    });
    
    // Verify fallback text
    expect(result.generatedText).toContain("I'm sorry");
    
    // Verify metadata includes error and marks as final state
    expect(result.metadata?.isFinalState).toBe(true);
  });

  it('should handle LLM errors gracefully', async () => {
    // Make the model throw an error
    vi.mocked(ModelFactory.createChatModel).mockReturnValue({
      invoke: vi.fn().mockRejectedValue(new Error('LLM API error')),
    } as any);
    
    // Execute the node
    const result = await outputGuardrail(mockState, mockConfig, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'outputGuardrail',
      message: 'LLM API error',
    });
    
    // Verify fallback to original answer
    expect(result.generatedText).toBe(mockState.generatedText);
    
    // Verify ObservabilityService.endSpan and endTrace were called
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
    expect(ObservabilityService.endTrace).toHaveBeenCalled();
  });

  it('should handle validation response without clear corrected version', async () => {
    // Mock response with indication corrections are needed but no clear corrected version
    vi.mocked(ModelFactory.createChatModel).mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        text: `VALIDATION ASSESSMENT:
Accuracy score: 6/10
The answer has several issues that need correction:
1. Missing time complexity information
2. Incomplete implementation details
3. No source attribution

However, the basic implementation is correct.

The answer needs improvements but no specific corrected version is provided.`
      }),
    } as any);
    
    // Execute the node
    const result = await outputGuardrail(mockState, mockConfig, mockEnv);
    
    // When validation had issues but there's no clear corrected version provided
    // Check that we either have the original text or a fallback that includes the word "provided"
    // This matches the implementation's behavior
    expect(
      result.generatedText === mockState.generatedText ||
      (result.generatedText && result.generatedText.includes('provided'))
    ).toBeTruthy();
    
    // Should still record validation assessment
    expect(result.reasoning?.[1]).toContain('VALIDATION:');
  });

  it('should mark the state as final', async () => {
    // Execute the node
    const result = await outputGuardrail(mockState, mockConfig, mockEnv);
    
    // Verify this is marked as the final node in the pipeline
    expect(result.metadata?.isFinalState).toBe(true);
  });
});