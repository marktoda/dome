# Node Implementations

This document provides detailed documentation for each node in the Chat RAG Graph. Each node is responsible for a specific function in the processing pipeline, from query analysis to response generation.

## State Definition

Before diving into the nodes, it's important to understand the state structure that flows through the graph:

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
    temperature?: number;
  };
  
  // Intermediate processing data
  tasks?: {
    originalQuery?: string;
    rewrittenQuery?: string;
    requiredTools?: string[];
    toolResults?: ToolResult[];
    needsWidening?: boolean;
    wideningAttempts?: number;
    queryAnalysis?: QueryAnalysisResult;
    toolToRun?: string;
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
    currentNode?: string;
    isFinalState?: boolean;
    errors?: ErrorRecord[];
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
    url?: string;
    mimeType?: string;
    tokenCount?: number;
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

/**
 * Query analysis result
 */
export interface QueryAnalysisResult {
  isComplex: boolean;
  shouldSplit: boolean;
  reason: string;
  suggestedQueries?: string[];
}

/**
 * Error record
 */
export interface ErrorRecord {
  node: string;
  message: string;
  timestamp: number;
  details?: unknown;
}
```

## 1. Split and Rewrite Node

The Split and Rewrite node analyzes the user's query and potentially rewrites it to improve retrieval.

### Functionality

- Extracts the last user message from conversation history
- Analyzes the query for complexity and ambiguity
- Determines if query rewriting is needed
- Rewrites the query if necessary to improve retrieval
- Updates the state with original and rewritten queries

### Implementation

```typescript
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
  
  // Analyze query complexity
  const queryAnalysis = await LlmService.analyzeQueryComplexity(
    env,
    originalQuery,
    { temperature: 0.2 }
  );
  
  // Determine if query needs rewriting
  let rewrittenQuery = originalQuery;
  let needsRewriting = queryAnalysis.isComplex || 
    /\b(it|this|that|they|these|those)\b/i.test(originalQuery);
  
  // Rewrite if needed
  if (needsRewriting) {
    try {
      rewrittenQuery = await LlmService.rewriteQuery(
        env,
        originalQuery,
        state.messages,
        { temperature: 0.3 }
      );
      
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
  
  return {
    ...state,
    tasks: {
      ...state.tasks,
      originalQuery,
      rewrittenQuery,
      queryAnalysis,
    },
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        splitRewrite: executionTime,
      },
      tokenCounts: {
        ...state.metadata?.tokenCounts,
        originalQuery: countTokens(originalQuery),
        rewrittenQuery: countTokens(rewrittenQuery),
      },
    },
  };
};
```

### Error Handling

- If no user message is found, returns empty queries
- If query rewriting fails, falls back to the original query
- Logs errors for monitoring and debugging

## 2. Retrieve Node

The Retrieve node fetches relevant documents based on the query.

### Functionality

- Uses the rewritten query (or original if rewriting failed)
- Adjusts search parameters based on widening attempts
- Fetches documents from the search service
- Processes and ranks the retrieved documents
- Determines if search widening is needed

### Implementation

```typescript
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
    // Perform search
    const searchResults = await SearchService.search(env, searchParams);
    
    // Process results
    const docs = searchResults || [];
    const docsCount = docs.length;
    
    // Rank and filter documents
    const rankedDocs = SearchService.rankAndFilterDocuments(docs, query);
    
    logger.info(
      { 
        docsCount, 
        rankedDocsCount: rankedDocs.length,
        query,
        wideningAttempts,
      }, 
      'Retrieved documents'
    );
    
    // Calculate total tokens in retrieved docs
    let totalTokens = 0;
    const processedDocs = rankedDocs.map(doc => {
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
    
    // Extract source metadata for client
    const sources = SearchService.extractSourceMetadata(processedDocs);
    
    // Log retrieval event
    ObservabilityService.logRetrieval(
      env,
      state.metadata?.traceId || '',
      {
        query,
        docsCount: processedDocs.length,
        totalTokens,
        wideningAttempts,
        sources,
      }
    );
    
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
            details: { query, userId },
          },
        ],
      },
    };
  }
};
```

### Error Handling

- If retrieval fails, returns empty docs array
- Records error in metadata for monitoring
- Continues execution flow despite errors

## 3. Route After Retrieve Node

The Route After Retrieve node determines the next step after retrieval.

### Functionality

- Examines retrieval results
- Determines if search widening is needed
- Checks if a tool is required
- Routes to the appropriate next node

### Implementation

```typescript
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
      'Need to widen search'
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
      'Detected tool intent'
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
```

### Decision Logic

- If `needsWidening` is true and widening attempts are below threshold, route to 'widen'
- If tool intent is detected, route to 'tool'
- Otherwise, route to 'answer'

## 4. Dynamic Widen Node

The Dynamic Widen node adjusts search parameters to widen the retrieval scope.

### Functionality

- Increments the widening attempts counter
- Prepares for another retrieval attempt with broader parameters

### Implementation

```typescript
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
    'Widening search parameters'
  );
  
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

### Widening Strategy

The actual parameter adjustments happen in the Retrieve node, which checks the `wideningAttempts` count and adjusts search parameters accordingly:

- Reducing relevance threshold
- Expanding to include synonyms
- Including related categories
- Expanding date ranges

## 5. Tool Router Node

The Tool Router node determines which tool to use.

### Functionality

- Examines the required tools list
- Selects the most appropriate tool
- Updates the state with the selected tool

### Implementation

```typescript
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
    'Selected tool to run'
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

export const routeAfterTool = (state: AgentState): 'run_tool' | 'answer' => {
  const toolToRun = state.tasks?.toolToRun;
  
  if (toolToRun) {
    return 'run_tool';
  }
  
  return 'answer';
};
```

### Tool Selection Logic

In the current implementation, the first tool in the required tools list is selected. In a more sophisticated implementation, an LLM could be used to select the most appropriate tool based on the query and available tools.

## 6. Run Tool Node

The Run Tool node executes the selected tool.

### Functionality

- Gets the selected tool from the registry
- Extracts tool input from the query
- Executes the tool
- Captures and processes the tool output
- Updates the state with tool results

### Implementation

```typescript
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
    'Running tool'
  );
  
  try {
    // Get tool from registry
    const tool = ToolRegistry.getTool(toolName);
    
    if (!tool) {
      throw new Error(`Tool ${toolName} not found in registry`);
    }
    
    // Extract tool input from query
    const toolInput = await extractToolInput(
      env,
      state.tasks?.originalQuery || '',
      toolName
    );
    
    // Execute tool
    const toolOutput = await tool.execute(toolInput, env);
    
    logger.info(
      { 
        toolName,
        toolInput,
        toolOutputPreview: typeof toolOutput === 'string' 
          ? toolOutput.substring(0, 100) 
          : 'complex output',
      }, 
      'Tool execution complete'
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
        toolResults: [
          ...(state.tasks?.toolResults || []),
          toolResult,
        ],
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
      'Error executing tool'
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
        toolResults: [
          ...(state.tasks?.toolResults || []),
          toolResult,
        ],
      },
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'runTool',
            message: error.message,
            timestamp: Date.now(),
            details: { toolName },
          },
        ],
      },
    };
  }
};
```

### Tool Input Extraction

The `extractToolInput` function uses an LLM to extract structured input for the tool from the user's query:

```typescript
async function extractToolInput(env: Bindings, query: string, toolName: string): Promise<unknown> {
  const logger = getLogger().child({ function: 'extractToolInput' });
  
  try {
    // Get tool schema
    const tool = ToolRegistry.getTool(toolName);
    const inputSchema = tool.getInputSchema();
    
    // Use LLM to extract structured input
    const extractedInput = await LlmService.extractToolInput(
      env,
      query,
      toolName,
      inputSchema,
      { temperature: 0.2 }
    );
    
    return extractedInput;
  } catch (error) {
    logger.error({ err: error, query, toolName }, 'Error extracting tool input');
    // Fall back to using the query as input
    return query;
  }
}
```

### Error Handling

- If tool execution fails, creates a tool result with error information
- Records error in metadata for monitoring
- Continues execution flow despite errors

## 7. Generate Answer Node

The Generate Answer node creates the final response.

### Functionality

- Prepares context from retrieved documents
- Formats tool results if any
- Builds a system prompt with context and tool results
- Calls the LLM to generate a response
- Updates the state with the generated text

### Implementation

```typescript
export const generateAnswer = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'generateAnswer' });
  const startTime = performance.now();
  
  // Prepare context from retrieved documents
  const docs = state.docs || [];
  const formattedDocs = formatDocsForPrompt(
    docs, 
    state.options.includeSourceInfo
  );
  
  // Prepare tool results if any
  const toolResults = state.tasks?.toolResults || [];
  const formattedToolResults = formatToolResultsForPrompt(toolResults);
  
  // Build system prompt
  const systemPrompt = buildSystemPrompt(
    formattedDocs,
    formattedToolResults
  );
  
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
    'Generating answer'
  );
  
  try {
    // Call LLM to generate response
    const response = await LlmService.generateResponse(
      env,
      messages,
      {
        temperature: state.options.temperature || 0.7,
        maxTokens: state.options.maxTokens || 1000,
      }
    );
    
    // Log LLM call
    ObservabilityService.logLlmCall(
      env,
      state.metadata?.traceId || '',
      'generate_answer',
      {
        model: LlmService.MODEL,
        promptTokens: countTokens(systemPrompt) + 
          state.messages.reduce((sum, msg) => sum + countTokens(msg.content), 0),
        completionTokens: countTokens(response),
        temperature: state.options.temperature || 0.7,
      }
    );
    
    logger.info(
      { 
        responseLength: response.length,
      }, 
      'Generated answer'
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
      'Error generating answer'
    );
    
    // Log error event
    ObservabilityService.logEvent(
      env,
      state.metadata?.traceId || '',
      state.userId,
      'answer_generation_error',
      {
        error: error.message,
        query: state.tasks?.originalQuery,
      }
    );
    
    // Provide fallback response
    return {
      ...state,
      generatedText: "I'm sorry, but I encountered an issue while generating a response. Please try again.",
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
```

### Prompt Building

The system prompt is built by combining the formatted documents and tool results:

```typescript
function buildSystemPrompt(
  formattedDocs: string,
  formattedToolResults: string
): string {
  let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";
  
  if (formattedDocs) {
    prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedDocs}\n\n`;
    prompt += 'When referencing information from these notes, include the note number in brackets, e.g., [1], to help the user identify the source.\n\n';
  }
  
  if (formattedToolResults) {
    prompt += `I've used tools to gather additional information:\n\n${formattedToolResults}\n\n`;
    prompt += 'Incorporate this tool-generated information into your response when relevant.\n\n';
  }
  
  prompt += 'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';
  
  return prompt;
}
```

### Document Formatting

Documents are formatted for inclusion in the prompt:

```typescript
function formatDocsForPrompt(docs: Document[], includeSourceInfo: boolean): string {
  if (docs.length === 0) {
    return '';
  }
  
  return docs
    .map((doc, index) => {
      let formattedDoc = `[${index + 1}] ${doc.title}\n${doc.body}`;
      
      if (includeSourceInfo && doc.metadata) {
        formattedDoc += `\nSource: ${doc.metadata.source}`;
        if (doc.metadata.url) {
          formattedDoc += ` (${doc.metadata.url})`;
        }
      }
      
      return formattedDoc;
    })
    .join('\n\n');
}
```

### Tool Result Formatting

Tool results are formatted for inclusion in the prompt:

```typescript
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

### Error Handling

- If response generation fails, provides a fallback response
- Records error in metadata for monitoring
- Logs error event for observability

## Stream Transformation

The stream transformation function converts the graph output to SSE events:

```typescript
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
            const sources = state.docs?.map(doc => ({
              id: doc.id,
              title: doc.title,
              source: doc.metadata.source,
              url: doc.metadata.url,
              relevanceScore: doc.metadata.relevanceScore,
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
```

## Conclusion

The node implementations form the core processing logic of the Chat RAG Graph system. Each node is designed to be:

1. **Focused** - Responsible for a single aspect of processing
2. **Observable** - Extensive logging and metrics collection
3. **Resilient** - Robust error handling
4. **Stateless** - Pure functions that transform state without side effects

Together, these nodes create a flexible, extensible system that can handle a wide range of conversational scenarios, from simple question answering to complex multi-step interactions involving external tools and knowledge sources.