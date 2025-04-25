# Extending the Graph

This guide provides instructions for extending the Chat RAG Graph with new nodes and modifying the graph structure. The graph-based architecture makes the system highly extensible, allowing you to add new capabilities or modify existing ones.

## Graph Architecture Overview

The Chat RAG Graph is built on LangChain's StateGraph framework, which provides a flexible way to define and execute directed graphs with state. The graph consists of:

- **Nodes**: Functions that process and transform state
- **Edges**: Connections between nodes that define the flow of execution
- **Conditional Edges**: Dynamic routing based on node outputs
- **State**: Data that flows through the graph and is transformed by nodes

## Adding a New Node

Let's walk through the process of adding a new node to the graph. We'll create a `summarizeContext` node that summarizes retrieved documents before generating an answer.

### 1. Define the Node Function

Create a new file `src/nodes/summarizeContext.ts`:

```typescript
import { getLogger } from '@dome/logging';
import { AgentState } from '../types';
import { LlmService } from '../services/llmService';
import { countTokens } from '../utils/tokenCounter';

/**
 * Summarize retrieved documents to create a concise context
 */
export const summarizeContext = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'summarizeContext' });
  const startTime = performance.now();

  // Skip if no documents or summarization is disabled
  if (!state.docs?.length || state.options.skipSummarization) {
    logger.info('No documents to summarize or summarization disabled');
    return state;
  }

  logger.info(
    {
      docsCount: state.docs.length,
      query: state.tasks?.rewrittenQuery || state.tasks?.originalQuery,
    },
    'Summarizing context',
  );

  try {
    // Prepare documents for summarization
    const docsText = state.docs
      .map(doc => `Title: ${doc.title}\nContent: ${doc.body}`)
      .join('\n\n');

    // Count tokens in documents
    const docsTokens = countTokens(docsText);

    // Skip summarization if documents are already concise
    if (docsTokens < 1000) {
      logger.info({ docsTokens }, 'Documents already concise, skipping summarization');
      return state;
    }

    // Create summarization prompt
    const query = state.tasks?.rewrittenQuery || state.tasks?.originalQuery || '';
    const prompt = `
      Summarize the following documents to create a concise context for answering the query: "${query}"
      
      ${docsText}
      
      Provide a concise summary that captures the key information relevant to the query.
      Include only factual information from the documents.
      Maintain the original meaning and important details.
      
      Summary:
    `;

    // Generate summary
    const summary = await LlmService.generateSummary(env, prompt, {
      temperature: 0.3,
      maxTokens: 500,
    });

    logger.info(
      {
        originalTokens: docsTokens,
        summaryTokens: countTokens(summary),
      },
      'Generated context summary',
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    return {
      ...state,
      contextSummary: summary,
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          summarizeContext: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          contextSummary: countTokens(summary),
        },
      },
    };
  } catch (error) {
    logger.error({ err: error }, 'Error summarizing context');

    // Return original state on error
    return {
      ...state,
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'summarizeContext',
            message: error.message,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};
```

### 2. Update the State Interface

Update the `AgentState` interface in `src/types.ts` to include the new `contextSummary` field:

```typescript
export interface AgentState {
  // User information
  userId: string;

  // Conversation history
  messages: Message[];

  // Configuration options
  options: {
    enhanceWithContext: boolean;
    maxContextItems: number;
    includeSourceInfo: boolean;
    maxTokens: number;
    temperature?: number;
    skipSummarization?: boolean; // New option
  };

  // Retrieved documents
  docs?: Document[];

  // Context summary (new field)
  contextSummary?: string;

  // Generated content
  generatedText?: string;

  // Other fields...
}
```

### 3. Add the Node to the Graph

Update the `buildChatGraph` function in `src/graph.ts` to include the new node:

```typescript
export const buildChatGraph = (env: Bindings) => {
  const logger = getLogger().child({ component: 'graphBuilder' });

  logger.info('Building chat graph');

  // Create checkpointer
  const checkpointer = new D1Checkpointer(env.D1);

  // Initialize graph
  const graph = new StateGraph<AgentState>()
    // Add nodes
    .addNode('split_rewrite', nodes.splitRewrite)
    .addNode('retrieve', nodes.retrieve)
    .addNode('dynamic_widen', nodes.dynamicWiden)
    .addNode('tool_router', nodes.toolRouter)
    .addNode('run_tool', nodes.runTool)
    .addNode('summarize_context', nodes.summarizeContext) // New node
    .addNode('generate_answer', nodes.generateAnswer)

    // Add edges
    .addEdge(START, 'split_rewrite')
    .addEdge('split_rewrite', 'retrieve')

    // Add conditional edges
    .addConditionalEdges('retrieve', nodes.routeAfterRetrieve, {
      widen: 'dynamic_widen',
      tool: 'tool_router',
      answer: 'summarize_context', // Changed from 'generate_answer'
    })
    .addEdge('dynamic_widen', 'retrieve')
    .addConditionalEdges('tool_router', nodes.routeAfterTool, {
      run_tool: 'run_tool',
      answer: 'summarize_context', // Changed from 'generate_answer'
    })
    .addEdge('run_tool', 'summarize_context') // Changed from 'generate_answer'
    .addEdge('summarize_context', 'generate_answer') // New edge
    .addEdge('generate_answer', END);

  // Rest of the function...
};
```

### 4. Update the Generate Answer Node

Update the `generateAnswer` node to use the context summary if available:

```typescript
export const generateAnswer = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'generateAnswer' });
  const startTime = performance.now();

  // Prepare context from retrieved documents or summary
  let formattedDocs = '';

  if (state.contextSummary) {
    // Use the summary if available
    formattedDocs = `Context Summary:\n${state.contextSummary}\n\n`;

    // Add source information if requested
    if (state.options.includeSourceInfo && state.docs) {
      formattedDocs += 'Sources:\n';
      formattedDocs += state.docs
        .map((doc, index) => {
          let source = `[${index + 1}] ${doc.title}`;
          if (doc.metadata.source) {
            source += ` (${doc.metadata.source})`;
          }
          return source;
        })
        .join('\n');
    }
  } else if (state.docs) {
    // Fall back to full document formatting
    formattedDocs = formatDocsForPrompt(state.docs, state.options.includeSourceInfo);
  }

  // Rest of the function...
};
```

### 5. Export the New Node

Update the `src/nodes/index.ts` file to export the new node:

```typescript
export { splitRewrite } from './splitRewrite';
export { retrieve } from './retrieve';
export { routeAfterRetrieve } from './routeAfterRetrieve';
export { dynamicWiden } from './dynamicWiden';
export { toolRouter, routeAfterTool } from './toolRouter';
export { runTool } from './runTool';
export { summarizeContext } from './summarizeContext'; // New export
export { generateAnswer } from './generateAnswer';
```

## Creating a Conditional Router

In addition to adding new processing nodes, you can create new conditional routers to dynamically control the flow of execution. Let's create a router that decides whether to summarize context based on document length.

```typescript
/**
 * Determine the next step after retrieval
 * @returns 'widen' | 'tool' | 'summarize' | 'answer'
 */
export const routeAfterRetrieve = (
  state: AgentState,
): 'widen' | 'tool' | 'summarize' | 'answer' => {
  const logger = getLogger().child({ node: 'routeAfterRetrieve' });

  // Check if we need to widen search
  if (state.tasks?.needsWidening) {
    return 'widen';
  }

  // Check if we need to use a tool
  const query = state.tasks?.originalQuery || '';
  const toolIntent = detectToolIntent(query);

  if (toolIntent.needsTool) {
    // Update state with required tools
    state.tasks = {
      ...state.tasks,
      requiredTools: toolIntent.tools,
    };

    return 'tool';
  }

  // Check if we need to summarize context
  if (state.docs && state.docs.length > 0) {
    // Calculate total tokens in documents
    const totalTokens = state.docs.reduce((sum, doc) => {
      return sum + countTokens(doc.title + ' ' + doc.body);
    }, 0);

    // If documents are lengthy, route to summarization
    if (totalTokens > 1000 && !state.options.skipSummarization) {
      return 'summarize';
    }
  }

  // Default to generating an answer
  return 'answer';
};
```

## Adding a Branch to the Graph

You can also add branches to the graph to handle different processing paths. Here's an example of adding a branch for complex queries:

```typescript
// Initialize graph
const graph = new StateGraph<AgentState>()
  // Add nodes
  .addNode('split_rewrite', nodes.splitRewrite)
  .addNode('retrieve', nodes.retrieve)
  // Add new nodes for complex query handling
  .addNode('breakdown_complex_query', nodes.breakdownComplexQuery)
  .addNode('process_sub_query', nodes.processSubQuery)
  .addNode('combine_results', nodes.combineResults)

  // Add conditional edge after split_rewrite
  .addConditionalEdges(
    'split_rewrite',
    state => {
      return state.tasks?.queryAnalysis?.isComplex ? 'complex' : 'simple';
    },
    {
      complex: 'breakdown_complex_query',
      simple: 'retrieve',
    },
  )

  // Complex query branch
  .addEdge('breakdown_complex_query', 'process_sub_query')
  .addEdge('process_sub_query', 'retrieve');

// Rest of the graph...
```

## Modifying Existing Nodes

You can also modify existing nodes to change their behavior. For example, to add personalization to the `generateAnswer` node:

```typescript
function buildSystemPromptWithPersonalization(
  formattedDocs: string,
  formattedToolResults: string,
  userPreferences?: AgentState['userPreferences'],
): string {
  let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";

  // Add personalization based on user preferences
  if (userPreferences) {
    if (userPreferences.expertiseLevel) {
      prompt += `Provide explanations at a ${userPreferences.expertiseLevel} level. `;
    }

    if (userPreferences.responseStyle) {
      switch (userPreferences.responseStyle) {
        case 'concise':
          prompt += 'Keep your responses brief and to the point. ';
          break;
        case 'detailed':
          prompt += 'Provide detailed and comprehensive responses. ';
          break;
        case 'conversational':
          prompt += 'Use a friendly, conversational tone in your responses. ';
          break;
      }
    }

    if (userPreferences.includeExamples) {
      prompt += 'Include examples to illustrate your points when appropriate. ';
    }
  }

  // Add context and tool results
  if (formattedDocs) {
    prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedDocs}\n\n`;
  }

  if (formattedToolResults) {
    prompt += `I've used tools to gather additional information:\n\n${formattedToolResults}\n\n`;
  }

  prompt +=
    'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';

  return prompt;
}
```

## Testing New Nodes

Always write tests for new nodes to ensure they work as expected:

```typescript
describe('summarizeContext Node', () => {
  // Mock environment
  const mockEnv = {} as Bindings;

  // Mock documents
  const mockDocs: Document[] = [
    {
      id: 'doc-1',
      title: 'Sample Document 1',
      body: 'This is the content of sample document 1.',
      metadata: {
        source: 'knowledge-base',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.95,
      },
    },
    {
      id: 'doc-2',
      title: 'Sample Document 2',
      body: 'This is the content of sample document 2.',
      metadata: {
        source: 'knowledge-base',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.85,
      },
    },
  ];

  it('should summarize context when documents are available', async () => {
    const result = await summarizeContext(
      {
        userId: 'user-123',
        messages: [{ role: 'user', content: 'What is the topic about?' }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        docs: mockDocs,
        metadata: {
          startTime: Date.now(),
          nodeTimings: {},
          tokenCounts: {},
        },
      },
      mockEnv,
    );

    expect(result.contextSummary).toBeDefined();
  });
});
```

## Best Practices for Extending the Graph

1. **Single Responsibility**: Each node should have a single, well-defined responsibility.

2. **Immutable State**: Use immutable update patterns for state transformations.

3. **Error Handling**: Implement robust error handling in all nodes.

4. **Observability**: Add logging and metrics to track node performance and behavior.

5. **Testing**: Write comprehensive tests for all new nodes and graph modifications.

6. **Documentation**: Document new nodes and graph changes.

7. **Backward Compatibility**: Ensure modifications don't break existing functionality.

8. **Performance Considerations**: Be mindful of the performance impact of new nodes.

## Conclusion

The graph-based architecture of the Chat RAG Graph solution makes it highly extensible. By adding new nodes, creating conditional routers, adding branches, and modifying existing nodes, you can customize the system to meet your specific requirements.

For more information on other aspects of the system, see the [Technical Documentation](../technical/README.md).
