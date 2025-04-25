# Chat RAG Graph Node Implementations

This document provides detailed pseudocode for implementing the core nodes of the Chat RAG Graph system. Each node represents a specific processing step in the conversation flow.

## 1. State Definition

First, let's define the state structure that will be passed between nodes:

```typescript
/**
 * Core state interface for the RAG graph
 */
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
  };

  // Intermediate processing data
  tasks?: {
    originalQuery?: string;
    rewrittenQuery?: string;
    requiredTools?: string[];
    toolResults?: ToolResult[];
    needsWidening?: boolean;
    wideningAttempts?: number;
  };

  // Retrieved documents
  docs?: Document[];

  // Generated content
  generatedText?: string;

  // Metadata for tracking and debugging
  metadata?: {
    startTime: number;
    nodeTimings: Record<string, number>;
    tokenCounts: Record<string, number>;
  };
}

/**
 * Message interface
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

/**
 * Document interface for retrieved content
 */
export interface Document {
  id: string;
  title: string;
  body: string;
  metadata: {
    source: string;
    createdAt: string;
    relevanceScore: number;
  };
}

/**
 * Tool result interface
 */
export interface ToolResult {
  toolName: string;
  input: unknown;
  output: unknown;
  error?: string;
}
```

## 2. Node Implementations

### 2.1 Split and Rewrite Node

This node analyzes the user's query and potentially rewrites it to improve retrieval.

````typescript
import { getLogger } from '@dome/logging';
import { countTokens } from '../utils/tokenCounter';

/**
 * Split and rewrite the user query to improve retrieval
 */
export const splitRewrite = async (state: AgentState): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'splitRewrite' });
  const startTime = performance.now();

  // Get the last user message
  const lastUserMessage = [...state.messages]
    .reverse()
    .find(msg => msg.role === 'user');

  if (!lastUserMessage) {
    logger.warn('No user message found in history');
    return {
      ...state,
      tasks: {
        ...state.tasks,
        originalQuery: '',
        rewrittenQuery: '',
      },
    };
  }

  const originalQuery = lastUserMessage.content;
  logger.info({ originalQuery, messageCount: state.messages.length }, 'Processing user query');

  // Count tokens in the query
  const tokenCount = countTokens(originalQuery);
  logger.debug({ tokenCount }, 'Counted tokens in query');

  // Determine if query needs rewriting
  let rewrittenQuery = originalQuery;
  let needsRewriting = false;

  // Check for multi-part questions
  if (originalQuery.includes('?') && originalQuery.split('?').length > 2) {
    needsRewriting = true;
  }

  // Check for ambiguous references that might need context
  if (/\b(it|this|that|they|these|those)\b/i.test(originalQuery)) {
    needsRewriting = true;
  }

  // Rewrite if needed
  if (needsRewriting) {
    try {
      // In a real implementation, this would call an LLM to rewrite the query
      // For pseudocode, we'll just simulate it
      rewrittenQuery = await simulateQueryRewrite(originalQuery);
      logger.info(
        { originalQuery, rewrittenQuery },
        'Query rewritten'
      );
    } catch (error) {
      logger.error(
        { err: error, originalQuery },
        'Failed to rewrite query'
      );
      // Fall back to original query
      rewrittenQuery = originalQuery;
    }
  }

  // Update state with timing information
  const endTime = performance.now();
  const executionTime = endTime - startTime;

  logger.info(
    {
      executionTimeMs: executionTime,
      originalQuery,
      rewrittenQuery,
    },
    'Split/rewrite complete'
  );

  return {
    ...state,
    tasks: {
      ...state.tasks,
      originalQuery,
      rewrittenQuery,
    },
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        splitRewrite: executionTime,
      },
      tokenCounts: {
        ...state.metadata?.tokenCounts,
        originalQuery: tokenCount,
        rewrittenQuery: countTokens(rewrittenQuery),
      },
    },
  };
};

/**
 * Simulate query rewriting (placeholder for actual LLM call)
 */
async function simulateQueryRewrite(query: string): Promise<string> {
  // This would be replaced with an actual LLM call in implementation
  if (query.includes('?') && query.split('?').length > 2) {
    // Split multi-part questions
    const parts = query.split('?').filter(Boolean);
    return parts[0] + '?';
  }

  // Expand pronouns
  return query
    .replace(/\bit\b/i, '[specific item from context]')
    .replace(/\bthis\b/i, '[specific item from context]')
    .replace(/\bthat\b/i, '[specific item from context]');
}
### 2.2 Retrieve Node

This node fetches relevant documents based on the query.

```typescript
import { getLogger } from '@dome/logging';
import { SearchService } from '../services/searchService';

/**
 * Retrieve relevant documents based on the query
 */
export const retrieve = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'retrieve' });
  const startTime = performance.now();

  // Skip retrieval if not enabled
  if (!state.options.enhanceWithContext) {
    logger.info('Context enhancement disabled, skipping retrieval');
    return {
      ...state,
      docs: [],
    };
  }

  const { userId } = state;
  const query = state.tasks?.rewrittenQuery || state.tasks?.originalQuery || '';
  const maxItems = state.options.maxContextItems || 10;

  // Track widening attempts
  const wideningAttempts = state.tasks?.wideningAttempts || 0;

  // Adjust search parameters based on widening attempts
  const searchParams = {
    userId,
    query,
    limit: maxItems,
  };

  // If we're widening, adjust search parameters
  if (wideningAttempts > 0) {
    logger.info(
      { wideningAttempts, query },
      'Widening search parameters'
    );

    // Expand search parameters based on widening attempt count
    // This could include reducing relevance threshold, expanding date range, etc.
    Object.assign(searchParams, {
      minRelevance: Math.max(0.5 - (wideningAttempts * 0.1), 0.2),
      expandSynonyms: true,
      includeRelated: true,
    });
  }

  logger.info(
    {
      userId,
      query,
      maxItems,
      wideningAttempts,
      searchParams,
    },
    'Retrieving context'
  );

  try {
    // Create search service instance
    const searchService = new SearchService();

    // Perform search
    const searchResults = await searchService.search(env, searchParams);

    // Process results
    const docs = searchResults?.results || [];
    const docsCount = docs.length;

    logger.info(
      {
        docsCount,
        query,
        wideningAttempts,
      },
      'Retrieved documents'
    );

    // Calculate total tokens in retrieved docs
    let totalTokens = 0;
    const processedDocs = docs.map(doc => {
      const docTokens = countTokens(doc.title + ' ' + doc.body);
      totalTokens += docTokens;

      return {
        ...doc,
        metadata: {
          ...doc.metadata,
          tokenCount: docTokens,
        },
      };
    });

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    return {
      ...state,
      docs: processedDocs,
      tasks: {
        ...state.tasks,
        needsWidening: docsCount < 2 && wideningAttempts < 2,
        wideningAttempts,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          retrievedDocs: totalTokens,
        },
      },
    };
  } catch (error) {
    logger.error(
      { err: error, userId, query },
      'Error retrieving context'
    );

    // Return state with empty docs on error
    return {
      ...state,
      docs: [],
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'retrieve',
            message: error.message,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};
````

### 2.3 Route After Retrieve Node

This node determines the next step after retrieval.

```typescript
import { getLogger } from '@dome/logging';

/**
 * Determine the next step after retrieval
 * @returns 'widen' | 'tool' | 'answer'
 */
export const routeAfterRetrieve = (state: AgentState): 'widen' | 'tool' | 'answer' => {
  const logger = getLogger().child({ node: 'routeAfterRetrieve' });

  // Check if we need to widen search
  if (state.tasks?.needsWidening) {
    const wideningAttempts = state.tasks?.wideningAttempts || 0;
    logger.info(
      {
        docsCount: state.docs?.length || 0,
        wideningAttempts,
      },
      'Need to widen search',
    );
    return 'widen';
  }

  // Check if we need to use a tool
  const query = state.tasks?.originalQuery || '';
  const toolIntent = detectToolIntent(query);

  if (toolIntent.needsTool) {
    logger.info(
      {
        toolIntent,
        query,
      },
      'Detected tool intent',
    );

    // Update state with required tools
    state.tasks = {
      ...state.tasks,
      requiredTools: toolIntent.tools,
    };

    return 'tool';
  }

  // Default to generating an answer
  logger.info('Proceeding to answer generation');
  return 'answer';
};

/**
 * Detect if the query requires a tool
 */
function detectToolIntent(query: string): { needsTool: boolean; tools: string[] } {
  // This would be more sophisticated in a real implementation
  // Could use an LLM or a classifier

  const toolPatterns = [
    { name: 'calculator', pattern: /calculate|compute|math|equation/i },
    { name: 'calendar', pattern: /schedule|appointment|meeting|calendar/i },
    { name: 'weather', pattern: /weather|temperature|forecast/i },
    { name: 'web_search', pattern: /search|find online|look up/i },
  ];

  const matchedTools = toolPatterns.filter(tool => tool.pattern.test(query)).map(tool => tool.name);

  return {
    needsTool: matchedTools.length > 0,
    tools: matchedTools,
  };
}
```

### 2.4 Dynamic Widen Node

This node adjusts search parameters to widen the retrieval scope.

```typescript
import { getLogger } from '@dome/logging';

/**
 * Widen search parameters for better retrieval
 */
export const dynamicWiden = async (state: AgentState): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'dynamicWiden' });
  const startTime = performance.now();

  // Increment widening attempts
  const wideningAttempts = (state.tasks?.wideningAttempts || 0) + 1;

  logger.info(
    {
      wideningAttempts,
      originalQuery: state.tasks?.originalQuery,
      rewrittenQuery: state.tasks?.rewrittenQuery,
    },
    'Widening search parameters',
  );

  // In a real implementation, we might:
  // 1. Expand the query with synonyms
  // 2. Reduce relevance thresholds
  // 3. Include related categories
  // 4. Expand date ranges

  // For this pseudocode, we'll just update the attempt counter
  // The retrieve node will handle the actual parameter adjustments

  // Update state with timing information
  const endTime = performance.now();
  const executionTime = endTime - startTime;

  return {
    ...state,
    tasks: {
      ...state.tasks,
      wideningAttempts,
    },
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        dynamicWiden: executionTime,
      },
    },
  };
};
```

### 2.5 Tool Router Node

This node determines which tool to use.

```typescript
import { getLogger } from '@dome/logging';

/**
 * Route to appropriate tool
 */
export const toolRouter = async (state: AgentState): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'toolRouter' });
  const startTime = performance.now();

  const requiredTools = state.tasks?.requiredTools || [];

  if (requiredTools.length === 0) {
    logger.warn('No tools specified but reached tool router');
    return {
      ...state,
      tasks: {
        ...state.tasks,
        toolToRun: null,
      },
    };
  }

  // For simplicity, just use the first tool
  // In a real implementation, we might use an LLM to select the most appropriate tool
  const toolToRun = requiredTools[0];

  logger.info(
    {
      toolToRun,
      allTools: requiredTools,
      query: state.tasks?.originalQuery,
    },
    'Selected tool to run',
  );

  // Update state with timing information
  const endTime = performance.now();
  const executionTime = endTime - startTime;

  return {
    ...state,
    tasks: {
      ...state.tasks,
      toolToRun,
    },
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        toolRouter: executionTime,
      },
    },
  };
};

/**
 * Determine next step after tool routing
 */
export const routeAfterTool = (state: AgentState): 'run_tool' | 'answer' => {
  const toolToRun = state.tasks?.toolToRun;

  if (toolToRun) {
    return 'run_tool';
  }

  return 'answer';
};
```

### 2.6 Run Tool Node

This node executes the selected tool.

```typescript
import { getLogger } from '@dome/logging';
import { ToolRegistry } from '../tools/registry';

/**
 * Execute the selected tool
 */
export const runTool = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'runTool' });
  const startTime = performance.now();

  const toolName = state.tasks?.toolToRun;

  if (!toolName) {
    logger.warn('No tool specified but reached run_tool node');
    return state;
  }

  logger.info(
    {
      toolName,
      query: state.tasks?.originalQuery,
    },
    'Running tool',
  );

  try {
    // Get tool from registry
    const tool = ToolRegistry.getTool(toolName);

    if (!tool) {
      throw new Error(`Tool ${toolName} not found in registry`);
    }

    // Extract tool input from query
    const toolInput = await extractToolInput(state.tasks?.originalQuery || '', toolName);

    // Execute tool
    const toolOutput = await tool.execute(toolInput, env);

    logger.info(
      {
        toolName,
        toolInput,
        toolOutputPreview:
          typeof toolOutput === 'string' ? toolOutput.substring(0, 100) : 'complex output',
      },
      'Tool execution complete',
    );

    // Create tool result
    const toolResult: ToolResult = {
      toolName,
      input: toolInput,
      output: toolOutput,
    };

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    return {
      ...state,
      tasks: {
        ...state.tasks,
        toolResults: [...(state.tasks?.toolResults || []), toolResult],
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          runTool: executionTime,
        },
      },
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        toolName,
      },
      'Error executing tool',
    );

    // Create error result
    const toolResult: ToolResult = {
      toolName,
      input: state.tasks?.originalQuery,
      output: null,
      error: error.message,
    };

    return {
      ...state,
      tasks: {
        ...state.tasks,
        toolResults: [...(state.tasks?.toolResults || []), toolResult],
      },
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'runTool',
            message: error.message,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};

/**
 * Extract tool input from query
 */
async function extractToolInput(query: string, toolName: string): Promise<unknown> {
  // In a real implementation, this would use an LLM to extract structured input
  // For pseudocode, we'll just return the query
  return query;
}
```

### 2.7 Generate Answer Node

This node generates the final response.

```typescript
import { getLogger } from '@dome/logging';
import { LlmClient } from '../services/llmClient';
import { formatDocsForPrompt } from '../utils/promptFormatter';

/**
 * Generate the final answer
 */
export const generateAnswer = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'generateAnswer' });
  const startTime = performance.now();

  // Prepare context from retrieved documents
  const docs = state.docs || [];
  const formattedDocs = formatDocsForPrompt(docs, state.options.includeSourceInfo);

  // Prepare tool results if any
  const toolResults = state.tasks?.toolResults || [];
  const formattedToolResults = formatToolResultsForPrompt(toolResults);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(formattedDocs, formattedToolResults);

  // Prepare messages for LLM
  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...state.messages,
  ];

  logger.info(
    {
      messageCount: messages.length,
      docsCount: docs.length,
      toolResultsCount: toolResults.length,
      systemPromptLength: systemPrompt.length,
    },
    'Generating answer',
  );

  try {
    // Call LLM to generate response
    const response = await LlmClient.call(env, messages);

    logger.info(
      {
        responseLength: response.length,
      },
      'Generated answer',
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    return {
      ...state,
      generatedText: response,
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          generateAnswer: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          systemPrompt: countTokens(systemPrompt),
          response: countTokens(response),
        },
      },
    };
  } catch (error) {
    logger.error(
      {
        err: error,
      },
      'Error generating answer',
    );

    // Provide fallback response
    return {
      ...state,
      generatedText:
        "I'm sorry, but I encountered an issue while generating a response. Please try again.",
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'generateAnswer',
            message: error.message,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};

/**
 * Build system prompt with context and tool results
 */
function buildSystemPrompt(formattedDocs: string, formattedToolResults: string): string {
  let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";

  if (formattedDocs) {
    prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedDocs}\n\n`;
    prompt +=
      'When referencing information from these notes, include the note number in brackets, e.g., [1], to help the user identify the source.\n\n';
  }

  if (formattedToolResults) {
    prompt += `I've used tools to gather additional information:\n\n${formattedToolResults}\n\n`;
    prompt += 'Incorporate this tool-generated information into your response when relevant.\n\n';
  }

  prompt +=
    'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';

  return prompt;
}

/**
 * Format tool results for inclusion in prompt
 */
function formatToolResultsForPrompt(toolResults: ToolResult[]): string {
  if (toolResults.length === 0) {
    return '';
  }

  return toolResults
    .map((result, index) => {
      const output = result.error
        ? `Error: ${result.error}`
        : typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output, null, 2);

      return `[Tool ${index + 1}] ${result.toolName}\nInput: ${result.input}\nOutput: ${output}`;
    })
    .join('\n\n');
}
```

## 3. Stream Transformation

To convert the graph output to SSE events:

```typescript
import { getLogger } from '@dome/logging';

/**
 * Transform graph output to SSE events
 */
export function transformToSSE(stream: AsyncIterable<AgentState>): ReadableStream {
  const logger = getLogger().child({ component: 'sseTransformer' });

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const state of stream) {
          // Determine event type based on state
          if (state.metadata?.currentNode) {
            // Send workflow step event
            const stepEvent = `event: workflow_step\ndata: ${JSON.stringify({
              step: state.metadata.currentNode,
            })}\n\n`;
            controller.enqueue(encoder.encode(stepEvent));
          }

          // If we have generated text, send answer event
          if (state.generatedText) {
            // Extract sources from docs if available
            const sources =
              state.docs?.map(doc => ({
                id: doc.id,
                title: doc.title,
                source: doc.metadata.source,
              })) || [];

            const answerEvent = `event: answer\ndata: ${JSON.stringify({
              delta: state.generatedText,
              sources,
            })}\n\n`;
            controller.enqueue(encoder.encode(answerEvent));
          }

          // If this is the final state, send done event
          if (state.metadata?.isFinalState) {
            const doneEvent = `event: done\ndata: ${JSON.stringify({
              executionTimeMs: getTotalExecutionTime(state),
            })}\n\n`;
            controller.enqueue(encoder.encode(doneEvent));
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Error in SSE stream transformation');

        // Send error event
        const errorEvent = `event: error\ndata: ${JSON.stringify({
          message: 'An error occurred during processing',
        })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Calculate total execution time from node timings
 */
function getTotalExecutionTime(state: AgentState): number {
  const nodeTimings = state.metadata?.nodeTimings || {};
  return Object.values(nodeTimings).reduce((sum, time) => sum + time, 0);
}
```

## 4. Graph Construction

Finally, putting it all together:

```typescript
import { StateGraph, START, END } from '@langchain/langgraph';
import * as nodes from './nodes';
import { D1Checkpointer } from './checkpointer';
import { getLogger } from '@dome/logging';

/**
 * Build the complete chat graph
 */
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
    .addNode('generate_answer', nodes.generateAnswer)

    // Add edges
    .addEdge(START, 'split_rewrite')
    .addEdge('split_rewrite', 'retrieve')

    // Add conditional edges
    .addConditionalEdges('retrieve', nodes.routeAfterRetrieve, {
      widen: 'dynamic_widen',
      tool: 'tool_router',
      answer: 'generate_answer',
    })
    .addEdge('dynamic_widen', 'retrieve')
    .addConditionalEdges('tool_router', nodes.routeAfterTool, {
      run_tool: 'run_tool',
      answer: 'generate_answer',
    })
    .addEdge('run_tool', 'generate_answer')
    .addEdge('generate_answer', END);

  // Add state change listener for logging
  graph.onStateChange((oldState, newState, nodeName) => {
    // Update current node in metadata
    newState.metadata = {
      ...newState.metadata,
      currentNode: nodeName,
      isFinalState: nodeName === END,
    };

    logger.debug(
      {
        node: nodeName,
        stateChanges: getStateDiff(oldState, newState),
      },
      'State transition',
    );
  });

  // Compile with checkpointer and reducers
  return graph.compile({
    checkpointer,
    reducers: {
      // Append docs to existing docs
      docs: (oldDocs = [], newDocs = []) => {
        if (!newDocs || newDocs.length === 0) return oldDocs;
        if (!oldDocs || oldDocs.length === 0) return newDocs;

        // Merge and deduplicate by ID
        const docMap = new Map();
        [...oldDocs, ...newDocs].forEach(doc => {
          docMap.set(doc.id, doc);
        });

        return Array.from(docMap.values());
      },

      // Merge tasks objects
      tasks: (oldTasks = {}, newTasks = {}) => ({
        ...oldTasks,
        ...newTasks,
      }),

      // Merge metadata
      metadata: (oldMetadata = {}, newMetadata = {}) => ({
        ...oldMetadata,
        ...newMetadata,
        nodeTimings: {
          ...(oldMetadata.nodeTimings || {}),
          ...(newMetadata.nodeTimings || {}),
        },
        tokenCounts: {
          ...(oldMetadata.tokenCounts || {}),
          ...(newMetadata.tokenCounts || {}),
        },
        errors: [...(oldMetadata.errors || []), ...(newMetadata.errors || [])],
      }),
    },
  });
};

/**
 * Get a summary of state changes for logging
 */
function getStateDiff(oldState: AgentState, newState: AgentState): Record<string, any> {
  const changes: Record<string, any> = {};

  // Check for new docs
  if (newState.docs?.length !== oldState.docs?.length) {
    changes.docsCount = {
      from: oldState.docs?.length || 0,
      to: newState.docs?.length || 0,
    };
  }

  // Check for new tool results
  if (newState.tasks?.toolResults?.length !== oldState.tasks?.toolResults?.length) {
    changes.toolResultsCount = {
      from: oldState.tasks?.toolResults?.length || 0,
      to: newState.tasks?.toolResults?.length || 0,
    };
  }

  // Check for generated text
  if (newState.generatedText && !oldState.generatedText) {
    changes.generatedText = true;
  }

  return changes;
}
```

## 5. Conclusion

This pseudocode provides a comprehensive implementation blueprint for the Chat RAG Graph system. Each node is designed to be:

1. **Modular** - Focused on a single responsibility
2. **Observable** - Extensive logging and metrics
3. **Resilient** - Error handling at each step
4. **Extensible** - Easy to add new nodes or modify existing ones

The implementation follows best practices for state management, error handling, and performance optimization. When implemented, this system will provide a robust foundation for the Dome Chat Orchestrator.
