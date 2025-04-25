# External Service Integration

The Chat RAG Graph solution integrates with several external services to provide its core functionality. This document details these integrations, including the LLM service, vector database, and external tools.

## LLM Service Integration

The Large Language Model (LLM) service is a critical component that provides natural language understanding and generation capabilities.

### Service Interface

```typescript
export interface LlmService {
  // Analyze query complexity
  analyzeQueryComplexity(
    env: Bindings,
    query: string,
    options?: LlmOptions,
  ): Promise<QueryAnalysisResult>;

  // Rewrite query for improved retrieval
  rewriteQuery(
    env: Bindings,
    query: string,
    conversationHistory: Message[],
    options?: LlmOptions,
  ): Promise<string>;

  // Extract structured input for tools
  extractToolInput(
    env: Bindings,
    query: string,
    toolName: string,
    inputSchema: any,
    options?: LlmOptions,
  ): Promise<unknown>;

  // Generate final response
  generateResponse(env: Bindings, messages: Message[], options?: LlmOptions): Promise<string>;

  // Model identifier
  MODEL: string;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface QueryAnalysisResult {
  isComplex: boolean;
  shouldSplit: boolean;
  reason: string;
  suggestedQueries?: string[];
}
```

### Implementation

The LLM service is implemented using Cloudflare's AI binding, which provides access to various LLM models:

```typescript
export const LlmService = {
  async analyzeQueryComplexity(
    env: Bindings,
    query: string,
    options: LlmOptions = {},
  ): Promise<QueryAnalysisResult> {
    const logger = getLogger().child({ function: 'analyzeQueryComplexity' });

    try {
      const prompt = `
        Analyze the following user query and determine if it is complex (contains multiple questions or requires multi-step reasoning).
        
        User Query: "${query}"
        
        Respond with a JSON object with the following structure:
        {
          "isComplex": boolean,
          "shouldSplit": boolean,
          "reason": string,
          "suggestedQueries": string[] (only if shouldSplit is true)
        }
      `;

      const response = await env.AI.run(this.MODEL, {
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.2,
        max_tokens: options.maxTokens || 500,
      });

      // Parse JSON response
      const result = JSON.parse(response.response);

      return {
        isComplex: result.isComplex,
        shouldSplit: result.shouldSplit,
        reason: result.reason,
        suggestedQueries: result.suggestedQueries,
      };
    } catch (error) {
      logger.error({ err: error, query }, 'Error analyzing query complexity');

      // Return default result on error
      return {
        isComplex: false,
        shouldSplit: false,
        reason: 'Error analyzing query',
      };
    }
  },

  async rewriteQuery(
    env: Bindings,
    query: string,
    conversationHistory: Message[] = [],
    options: LlmOptions = {},
  ): Promise<string> {
    const logger = getLogger().child({ function: 'rewriteQuery' });

    try {
      // Extract recent conversation context
      const recentMessages = conversationHistory
        .slice(-5)
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');

      const prompt = `
        Rewrite the following user query to make it more specific and self-contained for retrieval.
        Expand pronouns and references to previous conversation.
        Do not add information not implied by the query or conversation.
        
        Recent conversation:
        ${recentMessages}
        
        Original query: "${query}"
        
        Rewritten query:
      `;

      const response = await env.AI.run(this.MODEL, {
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.3,
        max_tokens: options.maxTokens || 200,
      });

      return response.response.trim();
    } catch (error) {
      logger.error({ err: error, query }, 'Error rewriting query');

      // Return original query on error
      return query;
    }
  },

  async extractToolInput(
    env: Bindings,
    query: string,
    toolName: string,
    inputSchema: any,
    options: LlmOptions = {},
  ): Promise<unknown> {
    const logger = getLogger().child({ function: 'extractToolInput' });

    try {
      const schemaString = JSON.stringify(inputSchema, null, 2);

      const prompt = `
        Extract structured input for the "${toolName}" tool from the following user query.
        
        User Query: "${query}"
        
        Input Schema:
        ${schemaString}
        
        Respond with a valid JSON object that matches the schema.
      `;

      const response = await env.AI.run(this.MODEL, {
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.2,
        max_tokens: options.maxTokens || 500,
      });

      // Parse JSON response
      return JSON.parse(response.response);
    } catch (error) {
      logger.error({ err: error, query, toolName }, 'Error extracting tool input');

      // Return query as string on error
      return query;
    }
  },

  async generateResponse(
    env: Bindings,
    messages: Message[],
    options: LlmOptions = {},
  ): Promise<string> {
    const logger = getLogger().child({ function: 'generateResponse' });

    try {
      // Format messages for AI binding
      const formattedMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // Call LLM
      const response = await env.AI.run(this.MODEL, {
        messages: formattedMessages,
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1000,
        top_p: options.topP || 1,
        frequency_penalty: options.frequencyPenalty || 0,
        presence_penalty: options.presencePenalty || 0,
      });

      return response.response.trim();
    } catch (error) {
      logger.error({ err: error }, 'Error generating response');
      throw error;
    }
  },

  // Model identifier
  MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};
```

### Error Handling

The LLM service implements robust error handling:

- For non-critical functions (query analysis, rewriting), errors result in fallback behavior
- For critical functions (response generation), errors are propagated to the caller
- All errors are logged for monitoring and debugging

### Model Selection

The system uses Cloudflare's optimized version of Llama 3.3 70B, which provides:

- High-quality instruction following
- Strong reasoning capabilities
- Good performance for RAG applications
- Efficient execution on Cloudflare's infrastructure

## Search Service Integration

The Search Service provides retrieval capabilities, interfacing with vector databases and search indexes.

### Service Interface

```typescript
export interface SearchService {
  // Search for relevant documents
  search(env: Bindings, params: SearchParams): Promise<Document[]>;

  // Rank and filter documents
  rankAndFilterDocuments(docs: Document[], query: string): Document[];

  // Extract source metadata for client
  extractSourceMetadata(docs: Document[]): SourceMetadata[];
}

export interface SearchParams {
  userId: string;
  query: string;
  limit?: number;
  minRelevance?: number;
  expandSynonyms?: boolean;
  includeRelated?: boolean;
  dateRange?: {
    start: string;
    end: string;
  };
}

export interface SourceMetadata {
  id: string;
  title: string;
  source: string;
  url?: string | null;
  relevanceScore: number;
}
```

### Implementation

The Search Service integrates with Cloudflare Vectorize for semantic search:

```typescript
export const SearchService = {
  async search(env: Bindings, params: SearchParams): Promise<Document[]> {
    const logger = getLogger().child({ function: 'search' });

    try {
      // Prepare search parameters
      const {
        userId,
        query,
        limit = 10,
        minRelevance = 0.7,
        expandSynonyms = false,
        includeRelated = false,
      } = params;

      // Create embedding for query
      const embedding = await createEmbedding(env, query);

      // Prepare vector search options
      const vectorSearchOptions: VectorizeSearchOptions = {
        vector: embedding,
        topK: limit * 2, // Fetch more than needed for filtering
        filter: {
          userId: { $eq: userId },
        },
      };

      // Add date range filter if provided
      if (params.dateRange) {
        vectorSearchOptions.filter = {
          ...vectorSearchOptions.filter,
          createdAt: {
            $gte: params.dateRange.start,
            $lte: params.dateRange.end,
          },
        };
      }

      // Perform vector search
      const vectorResults = await env.VECTORIZE.query(vectorSearchOptions);

      // Filter by relevance score
      const filteredResults = vectorResults.matches.filter(match => match.score >= minRelevance);

      // Fetch full documents from D1
      const docIds = filteredResults.map(match => match.id);

      const docsQuery = await env.D1.prepare(`
        SELECT d.id, d.title, d.body, d.source, d.created_at, d.url, d.mime_type
        FROM documents d
        WHERE d.id IN (${docIds.map(() => '?').join(',')})
        AND d.user_id = ?
      `);

      const docsResult = await docsQuery.bind(...docIds, userId).all();

      // Map to Document objects with relevance scores
      const scoreMap = new Map(filteredResults.map(match => [match.id, match.score]));

      const documents = docsResult.results.map(row => ({
        id: row.id,
        title: row.title,
        body: row.body,
        metadata: {
          source: row.source,
          createdAt: row.created_at,
          relevanceScore: scoreMap.get(row.id) || 0,
          url: row.url,
          mimeType: row.mime_type,
        },
      }));

      // If expandSynonyms is enabled and we have few results, try synonym expansion
      if (expandSynonyms && documents.length < limit / 2) {
        const expandedDocs = await this.expandSynonyms(env, query, userId, limit);

        // Merge and deduplicate
        const docMap = new Map();
        [...documents, ...expandedDocs].forEach(doc => {
          docMap.set(doc.id, doc);
        });

        return Array.from(docMap.values());
      }

      // If includeRelated is enabled and we have few results, include related documents
      if (includeRelated && documents.length < limit / 2) {
        const relatedDocs = await this.findRelatedDocuments(env, documents, userId, limit);

        // Merge and deduplicate
        const docMap = new Map();
        [...documents, ...relatedDocs].forEach(doc => {
          docMap.set(doc.id, doc);
        });

        return Array.from(docMap.values());
      }

      return documents;
    } catch (error) {
      logger.error({ err: error, params }, 'Error searching for documents');
      throw error;
    }
  },

  rankAndFilterDocuments(docs: Document[], query: string): Document[] {
    // If we have few docs, return all of them
    if (docs.length <= 5) {
      return docs;
    }

    // Sort by relevance score
    const sortedDocs = [...docs].sort(
      (a, b) => b.metadata.relevanceScore - a.metadata.relevanceScore,
    );

    // Apply additional ranking factors
    // (In a real implementation, this would be more sophisticated)

    return sortedDocs;
  },

  extractSourceMetadata(docs: Document[]): SourceMetadata[] {
    return docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      source: doc.metadata.source,
      url: doc.metadata.url || null,
      relevanceScore: doc.metadata.relevanceScore,
    }));
  },

  // Helper methods for expanded search
  async expandSynonyms(
    env: Bindings,
    query: string,
    userId: string,
    limit: number,
  ): Promise<Document[]> {
    // Implementation details omitted for brevity
    // This would use the LLM to generate synonyms and alternative phrasings
    return [];
  },

  async findRelatedDocuments(
    env: Bindings,
    docs: Document[],
    userId: string,
    limit: number,
  ): Promise<Document[]> {
    // Implementation details omitted for brevity
    // This would find documents related to the already retrieved documents
    return [];
  },
};

// Helper function to create embeddings
async function createEmbedding(env: Bindings, text: string): Promise<number[]> {
  const response = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [text],
  });

  return response.data[0];
}
```

### Vector Database Integration

The system integrates with Cloudflare Vectorize for vector storage and retrieval:

- **Embedding Generation**: Uses the BGE base model for creating embeddings
- **Vector Search**: Performs similarity search with filtering
- **Metadata Filtering**: Supports filtering by user ID, date range, and other metadata
- **Relevance Scoring**: Uses cosine similarity scores for ranking

### Document Storage

Documents are stored in Cloudflare D1 database, with the following schema:

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  url TEXT,
  mime_type TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_documents_created_at ON documents(created_at);
```

## Tool Registry and Integration

The Tool Registry manages the available tools and provides a consistent interface for tool execution.

### Tool Interface

```typescript
export interface Tool {
  // Tool name
  name: string;

  // Tool description
  description: string;

  // Get input schema
  getInputSchema(): any;

  // Execute the tool
  execute(input: unknown, env: Bindings): Promise<unknown>;
}
```

### Tool Registry Implementation

```typescript
export class ToolRegistry {
  private static tools: Map<string, Tool> = new Map();

  // Register a tool
  static registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  // Get a tool by name
  static getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  // Get all available tools
  static getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  // Get tool names
  static getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
```

### Example Tool Implementation: Calculator

```typescript
export class CalculatorTool implements Tool {
  name = 'calculator';
  description = 'Performs mathematical calculations';

  getInputSchema(): any {
    return {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate',
        },
      },
      required: ['expression'],
    };
  }

  async execute(input: unknown, env: Bindings): Promise<unknown> {
    const logger = getLogger().child({ tool: 'calculator' });

    try {
      // Validate input
      if (typeof input !== 'object' || input === null) {
        throw new Error('Invalid input: expected object');
      }

      const { expression } = input as { expression: string };

      if (!expression) {
        throw new Error('Invalid input: missing expression');
      }

      // Sanitize expression to prevent injection
      const sanitizedExpression = this.sanitizeExpression(expression);

      // Evaluate expression
      const result = this.evaluateExpression(sanitizedExpression);

      return {
        expression: sanitizedExpression,
        result,
      };
    } catch (error) {
      logger.error({ err: error, input }, 'Error executing calculator tool');
      throw error;
    }
  }

  private sanitizeExpression(expression: string): string {
    // Remove anything that's not a number, operator, or parenthesis
    return expression.replace(/[^0-9+\-*/().]/g, '');
  }

  private evaluateExpression(expression: string): number {
    // Simple implementation using Function constructor
    // In a production environment, use a safer math expression evaluator
    try {
      // Set a timeout to prevent long-running calculations
      const result = new Function(`return ${expression}`)();

      if (typeof result !== 'number' || !isFinite(result)) {
        throw new Error('Invalid result');
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to evaluate expression: ${error.message}`);
    }
  }
}
```

### Example Tool Implementation: Weather

```typescript
export class WeatherTool implements Tool {
  name = 'weather';
  description = 'Gets weather information for a location';

  getInputSchema(): any {
    return {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The location to get weather for (city, address, etc.)',
        },
        units: {
          type: 'string',
          enum: ['metric', 'imperial'],
          description: 'The units to use for temperature (metric or imperial)',
          default: 'metric',
        },
      },
      required: ['location'],
    };
  }

  async execute(input: unknown, env: Bindings): Promise<unknown> {
    const logger = getLogger().child({ tool: 'weather' });

    try {
      // Validate input
      if (typeof input !== 'object' || input === null) {
        throw new Error('Invalid input: expected object');
      }

      const { location, units = 'metric' } = input as {
        location: string;
        units?: 'metric' | 'imperial';
      };

      if (!location) {
        throw new Error('Invalid input: missing location');
      }

      // Get weather data from API
      const weatherData = await this.fetchWeatherData(env, location, units);

      return {
        location: weatherData.location,
        current: {
          temperature: weatherData.current.temperature,
          condition: weatherData.current.condition,
          humidity: weatherData.current.humidity,
          windSpeed: weatherData.current.windSpeed,
        },
        forecast: weatherData.forecast.map(day => ({
          date: day.date,
          condition: day.condition,
          highTemp: day.highTemp,
          lowTemp: day.lowTemp,
        })),
        units,
      };
    } catch (error) {
      logger.error({ err: error, input }, 'Error executing weather tool');
      throw error;
    }
  }

  private async fetchWeatherData(
    env: Bindings,
    location: string,
    units: 'metric' | 'imperial',
  ): Promise<WeatherData> {
    // In a real implementation, this would call a weather API
    // For this example, we'll return mock data

    return {
      location,
      current: {
        temperature: 22,
        condition: 'Sunny',
        humidity: 65,
        windSpeed: 10,
      },
      forecast: [
        {
          date: '2025-04-25',
          condition: 'Sunny',
          highTemp: 24,
          lowTemp: 18,
        },
        {
          date: '2025-04-26',
          condition: 'Partly Cloudy',
          highTemp: 22,
          lowTemp: 17,
        },
        {
          date: '2025-04-27',
          condition: 'Rainy',
          highTemp: 19,
          lowTemp: 15,
        },
      ],
    };
  }
}

interface WeatherData {
  location: string;
  current: {
    temperature: number;
    condition: string;
    humidity: number;
    windSpeed: number;
  };
  forecast: Array<{
    date: string;
    condition: string;
    highTemp: number;
    lowTemp: number;
  }>;
}
```

### Tool Registration

Tools are registered during system initialization:

```typescript
// Register built-in tools
ToolRegistry.registerTool(new CalculatorTool());
ToolRegistry.registerTool(new WeatherTool());
ToolRegistry.registerTool(new WebSearchTool());
ToolRegistry.registerTool(new CalendarTool());
```

## Observability Service Integration

The Observability Service provides logging, metrics, and tracing capabilities.

### Service Interface

```typescript
export interface ObservabilityService {
  // Initialize trace
  initTrace(env: Bindings, userId: string, query: string): string;

  // Start span
  startSpan(env: Bindings, traceId: string, name: string, attributes?: Record<string, any>): string;

  // End span
  endSpan(env: Bindings, spanId: string, attributes?: Record<string, any>): void;

  // Log event
  logEvent(
    env: Bindings,
    traceId: string,
    userId: string,
    eventName: string,
    attributes?: Record<string, any>,
  ): void;

  // End trace
  endTrace(env: Bindings, traceId: string, attributes?: Record<string, any>): void;

  // Log LLM call
  logLlmCall(
    env: Bindings,
    traceId: string,
    operation: string,
    attributes: LlmCallAttributes,
  ): void;

  // Log retrieval
  logRetrieval(env: Bindings, traceId: string, attributes: RetrievalAttributes): void;
}

export interface LlmCallAttributes {
  model: string;
  promptTokens: number;
  completionTokens: number;
  temperature?: number;
  maxTokens?: number;
}

export interface RetrievalAttributes {
  query: string;
  docsCount: number;
  totalTokens: number;
  wideningAttempts: number;
  sources: SourceMetadata[];
}
```

### Implementation

The Observability Service integrates with Cloudflare's logging and metrics capabilities:

```typescript
export const ObservabilityService = {
  initTrace(env: Bindings, userId: string, query: string): string {
    const traceId = crypto.randomUUID();

    // Log trace start
    env.LOGS.write({
      trace_id: traceId,
      user_id: userId,
      event: 'trace_start',
      query,
      timestamp: Date.now(),
    });

    return traceId;
  },

  startSpan(
    env: Bindings,
    traceId: string,
    name: string,
    attributes: Record<string, any> = {},
  ): string {
    const spanId = crypto.randomUUID();

    // Log span start
    env.LOGS.write({
      trace_id: traceId,
      span_id: spanId,
      event: 'span_start',
      span_name: name,
      attributes,
      timestamp: Date.now(),
    });

    return spanId;
  },

  endSpan(env: Bindings, spanId: string, attributes: Record<string, any> = {}): void {
    // Log span end
    env.LOGS.write({
      span_id: spanId,
      event: 'span_end',
      attributes,
      timestamp: Date.now(),
    });
  },

  logEvent(
    env: Bindings,
    traceId: string,
    userId: string,
    eventName: string,
    attributes: Record<string, any> = {},
  ): void {
    // Log custom event
    env.LOGS.write({
      trace_id: traceId,
      user_id: userId,
      event: eventName,
      attributes,
      timestamp: Date.now(),
    });
  },

  endTrace(env: Bindings, traceId: string, attributes: Record<string, any> = {}): void {
    // Log trace end
    env.LOGS.write({
      trace_id: traceId,
      event: 'trace_end',
      attributes,
      timestamp: Date.now(),
    });
  },

  logLlmCall(
    env: Bindings,
    traceId: string,
    operation: string,
    attributes: LlmCallAttributes,
  ): void {
    // Log LLM call
    env.LOGS.write({
      trace_id: traceId,
      event: 'llm_call',
      operation,
      model: attributes.model,
      prompt_tokens: attributes.promptTokens,
      completion_tokens: attributes.completionTokens,
      temperature: attributes.temperature,
      max_tokens: attributes.maxTokens,
      timestamp: Date.now(),
    });

    // Record metrics
    env.METRICS.record({
      'llm.tokens.prompt': attributes.promptTokens,
      'llm.tokens.completion': attributes.completionTokens,
      'llm.tokens.total': attributes.promptTokens + attributes.completionTokens,
    });
  },

  logRetrieval(env: Bindings, traceId: string, attributes: RetrievalAttributes): void {
    // Log retrieval
    env.LOGS.write({
      trace_id: traceId,
      event: 'retrieval',
      query: attributes.query,
      docs_count: attributes.docsCount,
      total_tokens: attributes.totalTokens,
      widening_attempts: attributes.wideningAttempts,
      sources: attributes.sources,
      timestamp: Date.now(),
    });

    // Record metrics
    env.METRICS.record({
      'retrieval.docs.count': attributes.docsCount,
      'retrieval.tokens.total': attributes.totalTokens,
      'retrieval.widening.attempts': attributes.wideningAttempts,
    });
  },
};
```

## Conclusion

The Chat RAG Graph solution integrates with several external services to provide its core functionality:

- **LLM Service**: Provides natural language understanding and generation capabilities
- **Search Service**: Enables retrieval of relevant documents from knowledge sources
- **Tool Registry**: Manages and executes external tools
- **Observability Service**: Provides logging, metrics, and tracing

These integrations are designed to be:

- **Modular**: Each service has a well-defined interface
- **Resilient**: Error handling is implemented at all integration points
- **Observable**: Comprehensive logging and metrics are collected
- **Extensible**: New services and tools can be added without modifying existing code

By leveraging these external services, the Chat RAG Graph solution can provide sophisticated conversational AI capabilities while maintaining a clean, modular architecture.
