import { describe, it, expect, vi, beforeEach } from 'vitest';
import { combineContextLLM } from './combineContextLLM';
import { ModelFactory } from '../services/modelFactory';
import { ObservabilityService } from '../services/observabilityService';
import { AgentState, Document, RerankedResult, DocumentChunk, ToolResult } from '../types';
import * as tokenCounter from '../utils/tokenCounter';
import * as promptHelpers from '../utils/promptHelpers';

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
    code: 'ERR_COMBINE_CONTEXT',
  })),
}));
vi.mock('../utils/tokenCounter');
vi.mock('../utils/promptHelpers');

// Mock performance API
global.performance = {
  now: vi.fn()
    .mockReturnValueOnce(100) // Start time
    .mockReturnValueOnce(400), // End time (300ms elapsed)
} as any;

// Mock crypto.randomUUID instead of replacing the entire crypto object
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => '123e4567-e89b-12d3-a456-426614174000');

describe('combineContextLLM Node', () => {
  let mockState: AgentState;
  let mockEnv: any;
  let mockCodeChunks: DocumentChunk[];
  let mockDocsChunks: DocumentChunk[];
  let mockCodeRerankedResult: RerankedResult;
  let mockDocsRerankedResult: RerankedResult;
  let mockToolResults: ToolResult[];
  let mockLlmResponse: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup mock data - code chunks
    mockCodeChunks = [
      {
        id: 'code-1',
        content: 'class BinarySearchTree:\n    def __init__(self):\n        self.root = None',
        metadata: {
          source: 'github',
          sourceType: 'code',
          language: 'python',
          title: 'BST Implementation',
          relevanceScore: 0.92,
          rerankerScore: 0.95,
        }
      },
      {
        id: 'code-2',
        content: 'def insert(self, value):\n    if self.root is None:\n        self.root = Node(value)',
        metadata: {
          source: 'github',
          sourceType: 'code',
          language: 'python',
          title: 'BST Insert Method',
          relevanceScore: 0.88,
          rerankerScore: 0.91,
        }
      }
    ];
    
    // Setup mock data - docs chunks
    mockDocsChunks = [
      {
        id: 'docs-1',
        content: 'Binary search trees are efficient data structures for lookups',
        metadata: {
          source: 'documentation',
          sourceType: 'docs',
          title: 'Data Structures Documentation',
          relevanceScore: 0.85,
          rerankerScore: 0.89,
        }
      }
    ];
    
    // Create reranked results
    mockCodeRerankedResult = {
      originalResults: {
        query: 'How do I implement a binary search tree in Python?',
        chunks: mockCodeChunks,
        sourceType: 'code',
        metadata: {
          executionTimeMs: 100,
          retrievalStrategy: 'vector',
          totalCandidates: 5
        }
      },
      rerankedChunks: mockCodeChunks,
      metadata: {
        rerankerModel: 'bge-reranker-code',
        executionTimeMs: 50,
        scoreThreshold: 0.25
      }
    };
    
    mockDocsRerankedResult = {
      originalResults: {
        query: 'How do I implement a binary search tree in Python?',
        chunks: mockDocsChunks,
        sourceType: 'docs',
        metadata: {
          executionTimeMs: 90,
          retrievalStrategy: 'vector',
          totalCandidates: 3
        }
      },
      rerankedChunks: mockDocsChunks,
      metadata: {
        rerankerModel: 'bge-reranker-docs',
        executionTimeMs: 45,
        scoreThreshold: 0.25
      }
    };
    
    // Setup mock tool results
    mockToolResults = [
      {
        toolName: 'PythonExamples',
        input: { query: 'binary search tree implementation' },
        output: 'class Node:\n    def __init__(self, data):\n        self.data = data\n        self.left = None\n        self.right = None'
      }
    ];
    
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
      rerankedResults: {
        code: mockCodeRerankedResult,
        docs: mockDocsRerankedResult
      },
      taskIds: ['task-1'],
      taskEntities: {
        'task-1': {
          id: 'task-1',
          toolResults: mockToolResults
        }
      },
      metadata: {
        traceId: 'trace-123',
      }
    };
    
    mockEnv = { 
      OPENAI_API_KEY: 'mock-api-key',
    };
    
    mockLlmResponse = {
      text: `# Synthesized Context for Binary Search Tree Implementation in Python

## Definition and Overview
Binary Search Trees (BSTs) are efficient data structures for lookups [Source: Data Structures Documentation]

## Implementation
### Basic BST Class
\`\`\`python
class BinarySearchTree:
    def __init__(self):
        self.root = None
\`\`\`
[Source: BST Implementation]

### Insert Method
\`\`\`python
def insert(self, value):
    if self.root is None:
        self.root = Node(value)
\`\`\`
[Source: BST Insert Method]

### Node Class (from Tool Results)
\`\`\`python
class Node:
    def __init__(self, data):
        self.data = data
        self.left = None
        self.right = None
\`\`\`
[Source: PythonExamples Tool]
`
    };
    
    // Mock formatDocsForPrompt
    vi.mocked(promptHelpers.formatDocsForPrompt).mockReturnValue(
      '[CODE] BST Implementation\nclass BinarySearchTree:\n    def __init__(self):\n        self.root = None\n\n' +
      '[CODE] BST Insert Method\ndef insert(self, value):\n    if self.root is None:\n        self.root = Node(value)\n\n' +
      '[DOCS] Data Structures Documentation\nBinary search trees are efficient data structures for lookups'
    );
    
    // Mock countTokens
    vi.mocked(tokenCounter.countTokens)
      .mockReturnValueOnce(30) // BST implementation
      .mockReturnValueOnce(35) // Insert method
      .mockReturnValueOnce(20) // Documentation
      .mockReturnValue(100);   // Default fallback
    
    // Mock ChatModel
    const mockChatModel = {
      invoke: vi.fn().mockResolvedValue(mockLlmResponse),
    };
    
    // Mock ModelFactory
    vi.mocked(ModelFactory.createChatModel).mockReturnValue(mockChatModel as any);
    
    // Mock ObservabilityService
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('span-123');
    vi.mocked(ObservabilityService.endSpan).mockImplementation(() => {});
  });

  it('should synthesize context from reranked results and tool results', async () => {
    // Execute the node
    const result = await combineContextLLM(mockState, mockEnv);
    
    // Verify the result
    expect(result).toBeDefined();
    expect(result.docs).toBeDefined();
    expect(result.sources).toBeDefined();
    expect(result.reasoning).toBeDefined();
    
    // Check that docs were processed correctly
    expect(result.docs?.length).toBe(3); // 2 code docs + 1 docs doc
    
    // Check that sources metadata was created
    expect(result.sources?.length).toBe(3);
    expect(result.sources?.some(s => s.title === 'BST Implementation')).toBe(true);
    
    // Check that the synthesized context was stored
    expect(result.reasoning?.[0]).toBe(mockLlmResponse.text);
    
    // Verify ModelFactory was called with correct parameters
    expect(ModelFactory.createChatModel).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        modelId: expect.any(String),
        temperature: 0.2,
        maxTokens: 2000
      })
    );
    
    // Verify model.invoke was called with a prompt containing the formatted content
    const modelInvoke = vi.mocked(ModelFactory.createChatModel).mock.results[0].value.invoke;
    expect(modelInvoke).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('How do I implement a binary search tree in Python?')
        })
      ])
    );
    
    // Verify the prompt contains both document content and tool results
    const prompt = modelInvoke.mock.calls[0][0][0].content;
    expect(prompt).toContain('[CODE]');
    expect(prompt).toContain('[DOCS]');
    expect(prompt).toContain('TOOL RESULTS');
    
    // Verify metadata
    expect(result.metadata).toMatchObject({
      currentNode: 'combineContextLLM',
      executionTimeMs: expect.any(Number),
    });
  });

  it('should handle state with no reranked results', async () => {
    // Setup state with no reranked results
    const stateWithoutResults = {
      ...mockState,
      rerankedResults: undefined
    };
    
    // Execute the node
    const result = await combineContextLLM(stateWithoutResults, mockEnv);
    
    // Verify the result still has a reasoning field with a synthesized context
    expect(result.reasoning).toBeDefined();
    
    // Since there are no reranked results, no docs should be in the result
    expect(result.docs?.length).toBe(0);
    
    // Verify the model was still called (might work with just tool results)
    expect(ModelFactory.createChatModel).toHaveBeenCalled();
  });

  it('should handle state with existing docs but no reranked results', async () => {
    // Setup state with existing docs but no reranked results
    const existingDocs: Document[] = [
      {
        id: 'existing-doc-1',
        title: 'Existing Document',
        body: 'This is an existing document in the state',
        metadata: {
          source: 'existing-source',
          relevanceScore: 0.75,
          createdAt: new Date().toISOString(),
        }
      }
    ];
    
    const stateWithExistingDocs = {
      ...mockState,
      rerankedResults: undefined,
      docs: existingDocs
    };
    
    // Execute the node
    const result = await combineContextLLM(stateWithExistingDocs, mockEnv);
    
    // Verify existing docs were used
    expect(result.docs?.length).toBe(1);
    expect(result.docs?.[0].id).toBe('existing-doc-1');
    
    // Verify the model was called with the existing docs
    expect(ModelFactory.createChatModel).toHaveBeenCalled();
  });

  it('should limit context based on token count', async () => {
    // Mock token counter to simulate a large document
    vi.mocked(tokenCounter.countTokens)
      .mockImplementation((text) => {
        // Return a huge token count for the first document to trigger truncation
        if (text.includes('class BinarySearchTree')) {
          return 10000; // Well over the context limit
        }
        return 50; // Small count for other documents
      });
    
    // Execute the node
    const result = await combineContextLLM(mockState, mockEnv);
    
    // Since the first document is too large, it should either be excluded or all docs are kept
    // but the total included docs should not exceed the original count
    expect(result.docs?.length).toBeLessThanOrEqual(3);
    
    // The first doc should be excluded due to token limit
    if (result.docs && result.docs.length > 0) {
      expect(result.docs[0].id).not.toBe('code-1');
    }
    
    // Verify the model was still called
    expect(ModelFactory.createChatModel).toHaveBeenCalled();
  });

  it('should handle LLM errors gracefully', async () => {
    // Make the model throw an error
    vi.mocked(ModelFactory.createChatModel).mockReturnValue({
      invoke: vi.fn().mockRejectedValue(new Error('LLM API error')),
    } as any);
    
    // Execute the node
    const result = await combineContextLLM(mockState, mockEnv);
    
    // Verify error handling
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.[0]).toMatchObject({
      node: 'combineContextLLM',
      message: 'LLM API error',
    });
    
    // Verify fallback reasoning was added
    expect(result.reasoning).toEqual([
      'Unable to synthesize context due to an error. Proceeding with raw documents.'
    ]);
    
    // Verify ObservabilityService.endSpan was called with error context
    expect(ObservabilityService.endSpan).toHaveBeenCalled();
  });

  it('should properly handle empty tool results', async () => {
    // Setup state with no tool results
    const stateWithoutToolResults = {
      ...mockState,
      taskEntities: {
        'task-1': {
          id: 'task-1',
          toolResults: []
        }
      }
    };
    
    // Execute the node
    const result = await combineContextLLM(stateWithoutToolResults, mockEnv);
    
    // Verify the result
    expect(result.reasoning).toBeDefined();
    
    // Verify the model was called without tool results
    const modelInvoke = vi.mocked(ModelFactory.createChatModel).mock.results[0].value.invoke;
    const prompt = modelInvoke.mock.calls[0][0][0].content;
    expect(prompt).not.toContain('TOOL RESULTS:');
  });
});