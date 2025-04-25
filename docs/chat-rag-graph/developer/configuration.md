# Configuration Guide

This guide provides detailed information on configuring the Chat RAG Graph solution. It covers environment variables, configuration options, and customization points.

## Environment Variables

The Chat RAG Graph solution uses environment variables for configuration. These can be set in the `.dev.vars` file for local development or in the Cloudflare Workers dashboard for production.

### Core Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DOME_API_URL` | URL of the Dome API | None | Yes |
| `DOME_API_KEY` | API key for the Dome API | None | Yes |
| `JWT_SECRET` | Secret for JWT verification | None | Yes |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` | No |
| `MAX_TOKENS` | Maximum tokens for response generation | `1000` | No |
| `DEFAULT_TEMPERATURE` | Default temperature for LLM calls | `0.7` | No |
| `ENABLE_STREAMING` | Enable streaming responses | `true` | No |

### LLM Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LLM_MODEL` | LLM model to use | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | No |
| `LLM_TIMEOUT` | Timeout for LLM calls (ms) | `30000` | No |
| `LLM_MAX_RETRIES` | Maximum retries for LLM calls | `3` | No |
| `LLM_RETRY_DELAY` | Delay between retries (ms) | `1000` | No |

### Retrieval Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MAX_CONTEXT_ITEMS` | Maximum number of context items to retrieve | `5` | No |
| `MIN_RELEVANCE_SCORE` | Minimum relevance score for retrieved documents | `0.7` | No |
| `ENABLE_WIDENING` | Enable search widening | `true` | No |
| `MAX_WIDENING_ATTEMPTS` | Maximum number of widening attempts | `2` | No |

### Tool Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ENABLE_TOOLS` | Enable tool usage | `true` | No |
| `ALLOWED_TOOLS` | Comma-separated list of allowed tools | All | No |
| `TOOL_TIMEOUT` | Timeout for tool execution (ms) | `5000` | No |

### Security Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ENABLE_RATE_LIMITING` | Enable rate limiting | `true` | No |
| `RATE_LIMIT_REQUESTS` | Maximum requests per hour | `100` | No |
| `ENABLE_CONTENT_FILTERING` | Enable content filtering | `true` | No |
| `ENCRYPTION_KEY` | Key for encrypting sensitive data | None | Yes (in production) |

## Configuration File

In addition to environment variables, the Chat RAG Graph solution can be configured using a configuration file. This file is located at `src/config.ts` and provides default values for various settings.

```typescript
// src/config.ts
export const config = {
  // Core configuration
  api: {
    domeApiUrl: process.env.DOME_API_URL || 'https://api.dome.cloud',
    domeApiKey: process.env.DOME_API_KEY || '',
  },
  
  // LLM configuration
  llm: {
    model: process.env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    timeout: parseInt(process.env.LLM_TIMEOUT || '30000', 10),
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.LLM_RETRY_DELAY || '1000', 10),
    defaultTemperature: parseFloat(process.env.DEFAULT_TEMPERATURE || '0.7'),
    maxTokens: parseInt(process.env.MAX_TOKENS || '1000', 10),
  },
  
  // Retrieval configuration
  retrieval: {
    maxContextItems: parseInt(process.env.MAX_CONTEXT_ITEMS || '5', 10),
    minRelevanceScore: parseFloat(process.env.MIN_RELEVANCE_SCORE || '0.7'),
    enableWidening: process.env.ENABLE_WIDENING !== 'false',
    maxWideningAttempts: parseInt(process.env.MAX_WIDENING_ATTEMPTS || '2', 10),
  },
  
  // Tool configuration
  tools: {
    enableTools: process.env.ENABLE_TOOLS !== 'false',
    allowedTools: process.env.ALLOWED_TOOLS ? 
      process.env.ALLOWED_TOOLS.split(',') : 
      ['calculator', 'weather', 'web_search', 'calendar'],
    timeout: parseInt(process.env.TOOL_TIMEOUT || '5000', 10),
  },
  
  // Security configuration
  security: {
    enableRateLimiting: process.env.ENABLE_RATE_LIMITING !== 'false',
    rateLimitRequests: parseInt(process.env.RATE_LIMIT_REQUESTS || '100', 10),
    enableContentFiltering: process.env.ENABLE_CONTENT_FILTERING !== 'false',
    encryptionKey: process.env.ENCRYPTION_KEY || '',
  },
  
  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableStructuredLogs: true,
  },
  
  // Feature flags
  features: {
    enableStreaming: process.env.ENABLE_STREAMING !== 'false',
    enableCheckpointing: true,
    enableObservability: true,
  },
};
```

## Request Configuration

Users can configure certain aspects of the Chat RAG Graph solution on a per-request basis. These options are passed in the request body:

```json
{
  "messages": [
    {"role": "user", "content": "What is the capital of France?"}
  ],
  "options": {
    "enhanceWithContext": true,
    "maxContextItems": 5,
    "includeSourceInfo": true,
    "maxTokens": 1000,
    "temperature": 0.7,
    "stream": true
  }
}
```

### Request Options

| Option | Description | Default |
|--------|-------------|---------|
| `enhanceWithContext` | Whether to enhance responses with retrieved context | `true` |
| `maxContextItems` | Maximum number of context items to retrieve | `5` |
| `includeSourceInfo` | Whether to include source information in responses | `true` |
| `maxTokens` | Maximum tokens for response generation | `1000` |
| `temperature` | Temperature for LLM calls | `0.7` |
| `stream` | Whether to stream the response | `false` |

## Graph Configuration

The graph structure itself can be configured by modifying the `buildChatGraph` function in `src/graph.ts`. This allows you to:

- Add or remove nodes
- Change the connections between nodes
- Modify the conditional routing logic

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
      'State transition'
    );
  });
  
  // Compile with checkpointer and reducers
  return graph.compile({
    checkpointer,
    reducers: {
      // Reducers for state merging
      // ...
    },
  });
};
```

## Node Configuration

Individual nodes can be configured by modifying their implementation in the `src/nodes` directory. Each node is a function that takes a state object and returns a new state object.

For example, to configure the `retrieve` node:

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
  
  // Use configuration from state or fall back to global config
  const maxItems = state.options.maxContextItems || config.retrieval.maxContextItems;
  const minRelevance = config.retrieval.minRelevanceScore;
  
  // Rest of the node implementation
  // ...
};
```

## Tool Configuration

Tools can be configured by modifying their implementation in the `src/tools` directory. Each tool is a class that implements the `Tool` interface.

For example, to configure the `calculator` tool:

```typescript
export class CalculatorTool implements Tool {
  name = 'calculator';
  description = 'Performs mathematical calculations';
  
  // Tool configuration
  private config = {
    maxExpressionLength: 1000,
    timeout: 1000, // ms
  };
  
  constructor(customConfig?: Partial<typeof this.config>) {
    // Apply custom configuration
    if (customConfig) {
      this.config = {
        ...this.config,
        ...customConfig,
      };
    }
  }
  
  // Rest of the tool implementation
  // ...
}
```

## Prompt Configuration

Prompts used for LLM calls can be configured by modifying the `src/prompts` directory. Each prompt is a function that takes parameters and returns a string.

For example, to configure the system prompt for answer generation:

```typescript
export function buildSystemPrompt(
  formattedDocs: string,
  formattedToolResults: string,
  options: {
    includeSourceInfo: boolean;
    customInstructions?: string;
  }
): string {
  let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";
  
  // Add custom instructions if provided
  if (options.customInstructions) {
    prompt += options.customInstructions + " ";
  }
  
  if (formattedDocs) {
    prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedDocs}\n\n`;
    
    if (options.includeSourceInfo) {
      prompt += 'When referencing information from these notes, include the note number in brackets, e.g., [1], to help the user identify the source.\n\n';
    }
  }
  
  if (formattedToolResults) {
    prompt += `I've used tools to gather additional information:\n\n${formattedToolResults}\n\n`;
    prompt += 'Incorporate this tool-generated information into your response when relevant.\n\n';
  }
  
  prompt += 'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';
  
  return prompt;
}
```

## Advanced Configuration

### Custom State Reducers

You can configure how state is merged during graph execution by modifying the reducers in the `buildChatGraph` function:

```typescript
return graph.compile({
  checkpointer,
  reducers: {
    // Append docs to existing docs
    docs: (oldDocs = [], newDocs = []) => {
      if (!newDocs || newDocs.length === 0) return oldDocs;
      if (!oldDocs || oldDocs.length === 0) return newDocs;
      
      // Custom merging logic
      const docMap = new Map();
      [...oldDocs, ...newDocs].forEach(doc => {
        docMap.set(doc.id, doc);
      });
      
      return Array.from(docMap.values());
    },
    
    // Other reducers
    // ...
  },
});
```

### Custom Checkpointing

You can configure the checkpointing behavior by modifying the `D1Checkpointer` class or implementing a custom checkpointer:

```typescript
export class CustomCheckpointer implements Checkpointer<AgentState> {
  // Custom implementation
  // ...
}

// Use custom checkpointer
const checkpointer = new CustomCheckpointer();
```

### Custom Observability

You can configure the observability behavior by modifying the `ObservabilityService`:

```typescript
// Add custom metrics
ObservabilityService.logEvent(
  env,
  state.metadata?.traceId || '',
  state.userId,
  'custom_event',
  {
    customMetric1: value1,
    customMetric2: value2,
  }
);
```

## Environment-Specific Configuration

You can create environment-specific configuration by using different `.dev.vars` files or environment variables in different environments:

### Development

```
# .dev.vars
LOG_LEVEL=debug
ENABLE_CONTENT_FILTERING=false
```

### Staging

```
# Set in Cloudflare Workers dashboard
LOG_LEVEL=info
ENABLE_CONTENT_FILTERING=true
```

### Production

```
# Set in Cloudflare Workers dashboard
LOG_LEVEL=warn
ENABLE_CONTENT_FILTERING=true
ENABLE_RATE_LIMITING=true
```

## Configuration Best Practices

1. **Use Environment Variables for Sensitive Information**: Never hardcode sensitive information like API keys or secrets in the code.

2. **Provide Sensible Defaults**: Always provide sensible default values for configuration options to ensure the system works even if not all options are explicitly set.

3. **Validate Configuration**: Validate configuration values to ensure they are within acceptable ranges and of the correct type.

4. **Document Configuration Options**: Document all configuration options, including their purpose, default values, and acceptable ranges.

5. **Use Feature Flags**: Use feature flags to enable or disable features, making it easier to roll out new functionality gradually.

6. **Centralize Configuration**: Keep configuration centralized in a single file or module to make it easier to manage.

7. **Environment-Specific Configuration**: Use environment-specific configuration files or variables for different environments (development, staging, production).

8. **Configuration Hierarchy**: Implement a configuration hierarchy where request-specific options override global options.

## Conclusion

The Chat RAG Graph solution provides a flexible configuration system that allows you to customize its behavior to meet your specific requirements. By using environment variables, configuration files, and code modifications, you can control every aspect of the system's behavior.

For more information on extending the system with new functionality, see the [Adding New Tools](./adding-tools.md) and [Extending the Graph](./extending-graph.md) guides.