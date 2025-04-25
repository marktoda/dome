# Adding New Tools

This guide provides instructions for adding new tools to the Chat RAG Graph solution. Tools extend the system's capabilities by allowing it to perform specific actions or retrieve information from external sources.

## Tool Architecture

Tools in the Chat RAG Graph solution follow a consistent architecture:

1. **Tool Interface**: All tools implement the `Tool` interface
2. **Tool Registry**: Tools are registered with the `ToolRegistry`
3. **Tool Detection**: The system detects when a tool is needed
4. **Tool Execution**: The system executes the appropriate tool
5. **Result Integration**: Tool results are integrated into the response

## Tool Interface

All tools must implement the `Tool` interface:

```typescript
export interface Tool {
  // Tool name (used for identification)
  name: string;

  // Tool description (used for documentation and LLM context)
  description: string;

  // Get input schema (used for input validation and extraction)
  getInputSchema(): any;

  // Execute the tool
  execute(input: unknown, env: Bindings): Promise<unknown>;
}
```

## Creating a New Tool

Let's walk through the process of creating a new tool. We'll create a `TranslationTool` that translates text from one language to another.

### 1. Create the Tool Class

Create a new file `src/tools/translationTool.ts`:

```typescript
import { Tool } from '../types';
import { getLogger } from '@dome/logging';

export class TranslationTool implements Tool {
  name = 'translation';
  description = 'Translates text from one language to another';

  getInputSchema(): any {
    return {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to translate',
        },
        sourceLanguage: {
          type: 'string',
          description: 'The source language (e.g., "en", "fr", "es")',
        },
        targetLanguage: {
          type: 'string',
          description: 'The target language (e.g., "en", "fr", "es")',
        },
      },
      required: ['text', 'targetLanguage'],
    };
  }

  async execute(input: unknown, env: Bindings): Promise<unknown> {
    const logger = getLogger().child({ tool: 'translation' });

    try {
      // Validate input
      if (typeof input !== 'object' || input === null) {
        throw new Error('Invalid input: expected object');
      }

      const {
        text,
        sourceLanguage = 'auto',
        targetLanguage,
      } = input as {
        text: string;
        sourceLanguage?: string;
        targetLanguage: string;
      };

      if (!text) {
        throw new Error('Invalid input: missing text');
      }

      if (!targetLanguage) {
        throw new Error('Invalid input: missing targetLanguage');
      }

      logger.info(
        {
          textLength: text.length,
          sourceLanguage,
          targetLanguage,
        },
        'Translating text',
      );

      // Call translation service
      const translatedText = await this.translateText(env, text, sourceLanguage, targetLanguage);

      return {
        originalText: text,
        translatedText,
        sourceLanguage,
        targetLanguage,
      };
    } catch (error) {
      logger.error({ err: error, input }, 'Error executing translation tool');
      throw error;
    }
  }

  private async translateText(
    env: Bindings,
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string> {
    // In a real implementation, this would call a translation API
    // For this example, we'll use the LLM to perform the translation

    const prompt = `
      Translate the following text from ${
        sourceLanguage === 'auto' ? 'the detected language' : sourceLanguage
      } to ${targetLanguage}:
      
      "${text}"
      
      Translation:
    `;

    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    });

    return response.response.trim();
  }
}
```

### 2. Register the Tool

Update the tool registry initialization in `src/tools/index.ts`:

```typescript
import { ToolRegistry } from './registry';
import { CalculatorTool } from './calculatorTool';
import { WeatherTool } from './weatherTool';
import { WebSearchTool } from './webSearchTool';
import { CalendarTool } from './calendarTool';
import { TranslationTool } from './translationTool';

// Initialize tool registry
export function initializeToolRegistry(): void {
  // Register built-in tools
  ToolRegistry.registerTool(new CalculatorTool());
  ToolRegistry.registerTool(new WeatherTool());
  ToolRegistry.registerTool(new WebSearchTool());
  ToolRegistry.registerTool(new CalendarTool());

  // Register new translation tool
  ToolRegistry.registerTool(new TranslationTool());
}
```

### 3. Update Tool Detection

Update the tool detection logic in the `routeAfterRetrieve` node to recognize translation requests:

```typescript
function detectToolIntent(query: string): { needsTool: boolean; tools: string[] } {
  // This would be more sophisticated in a real implementation
  // Could use an LLM or a classifier

  const toolPatterns = [
    { name: 'calculator', pattern: /calculate|compute|math|equation/i },
    { name: 'calendar', pattern: /schedule|appointment|meeting|calendar/i },
    { name: 'weather', pattern: /weather|temperature|forecast/i },
    { name: 'web_search', pattern: /search|find online|look up/i },
    // Add pattern for translation tool
    { name: 'translation', pattern: /translate|translation|convert to \w+|in \w+/i },
  ];

  const matchedTools = toolPatterns.filter(tool => tool.pattern.test(query)).map(tool => tool.name);

  return {
    needsTool: matchedTools.length > 0,
    tools: matchedTools,
  };
}
```

### 4. Test the Tool

Create a test for the new tool in `tests/tools/translationTool.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslationTool } from '../../src/tools/translationTool';

describe('TranslationTool', () => {
  let tool: TranslationTool;

  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn().mockResolvedValue({
        response: 'Bonjour, comment ça va?',
      }),
    },
  } as unknown as Bindings;

  beforeEach(() => {
    tool = new TranslationTool();
    vi.clearAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(tool.name).toBe('translation');
    expect(tool.description).toBe('Translates text from one language to another');
  });

  it('should provide an input schema', () => {
    const schema = tool.getInputSchema();

    expect(schema).toHaveProperty('properties.text');
    expect(schema).toHaveProperty('properties.sourceLanguage');
    expect(schema).toHaveProperty('properties.targetLanguage');
    expect(schema.required).toContain('text');
    expect(schema.required).toContain('targetLanguage');
  });

  it('should translate text successfully', async () => {
    const input = {
      text: 'Hello, how are you?',
      sourceLanguage: 'en',
      targetLanguage: 'fr',
    };

    const result = await tool.execute(input, mockEnv);

    expect(result).toEqual({
      originalText: 'Hello, how are you?',
      translatedText: 'Bonjour, comment ça va?',
      sourceLanguage: 'en',
      targetLanguage: 'fr',
    });

    expect(mockEnv.AI.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining('Translate the following text'),
          }),
        ]),
      }),
    );
  });

  it('should use auto-detection when sourceLanguage is not provided', async () => {
    const input = {
      text: 'Hello, how are you?',
      targetLanguage: 'fr',
    };

    const result = await tool.execute(input, mockEnv);

    expect(result).toEqual({
      originalText: 'Hello, how are you?',
      translatedText: 'Bonjour, comment ça va?',
      sourceLanguage: 'auto',
      targetLanguage: 'fr',
    });

    expect(mockEnv.AI.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining('the detected language'),
          }),
        ]),
      }),
    );
  });

  it('should throw an error when text is missing', async () => {
    const input = {
      targetLanguage: 'fr',
    };

    await expect(tool.execute(input, mockEnv)).rejects.toThrow('missing text');
  });

  it('should throw an error when targetLanguage is missing', async () => {
    const input = {
      text: 'Hello, how are you?',
    };

    await expect(tool.execute(input, mockEnv)).rejects.toThrow('missing targetLanguage');
  });
});
```

## Tool Input Extraction

When a tool is selected for execution, the system needs to extract structured input from the user's query. This is handled by the `extractToolInput` function in the `runTool` node:

```typescript
async function extractToolInput(env: Bindings, query: string, toolName: string): Promise<unknown> {
  const logger = getLogger().child({ function: 'extractToolInput' });

  try {
    // Get tool schema
    const tool = ToolRegistry.getTool(toolName);

    if (!tool) {
      throw new Error(`Tool ${toolName} not found in registry`);
    }

    const inputSchema = tool.getInputSchema();

    // Use LLM to extract structured input
    const prompt = `
      Extract the necessary information from the user query to use the "${toolName}" tool.
      
      User Query: "${query}"
      
      The tool requires the following input schema:
      ${JSON.stringify(inputSchema, null, 2)}
      
      Extract the required information and provide it as a valid JSON object that matches the schema.
      If any required fields are missing, make reasonable assumptions based on the query.
      
      JSON Output:
    `;

    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    });

    // Parse JSON response
    try {
      return JSON.parse(response.response.trim());
    } catch (parseError) {
      logger.error(
        { err: parseError, response: response.response },
        'Error parsing tool input JSON',
      );

      // Fall back to simple extraction
      return fallbackExtraction(query, toolName, inputSchema);
    }
  } catch (error) {
    logger.error({ err: error, query, toolName }, 'Error extracting tool input');

    // Fall back to using the query as input
    return { text: query };
  }
}
```

## Tool Result Integration

Tool results are integrated into the response by the `generateAnswer` node. The results are formatted and included in the system prompt:

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

      return `[Tool ${index + 1}] ${result.toolName}\nInput: ${JSON.stringify(
        result.input,
        null,
        2,
      )}\nOutput: ${output}`;
    })
    .join('\n\n');
}
```

## Advanced Tool Features

### Tool Configuration

Tools can be configured with custom options:

```typescript
export class TranslationTool implements Tool {
  name = 'translation';
  description = 'Translates text from one language to another';

  // Tool configuration
  private config = {
    maxTextLength: 5000,
    supportedLanguages: ['en', 'fr', 'es', 'de', 'it', 'ja', 'zh', 'ru'],
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
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

### Tool Chaining

Tools can be chained together by having one tool call another:

```typescript
export class CompoundTool implements Tool {
  name = 'compound';
  description = 'Performs a sequence of operations using multiple tools';

  private toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  getInputSchema(): any {
    return {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                description: 'The name of the tool to use',
              },
              input: {
                type: 'object',
                description: 'The input for the tool',
              },
            },
            required: ['tool', 'input'],
          },
        },
      },
      required: ['operations'],
    };
  }

  async execute(input: unknown, env: Bindings): Promise<unknown> {
    // Implementation of tool chaining
    // ...
  }
}
```

### Tool Authentication

Tools that access external APIs often require authentication:

```typescript
export class ApiTool implements Tool {
  name = 'api';
  description = 'Accesses an external API';

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async execute(input: unknown, env: Bindings): Promise<unknown> {
    // Use API key for authentication
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    // Make API request
    // ...
  }
}
```

### Tool Rate Limiting

Tools can implement rate limiting to prevent abuse:

```typescript
export class RateLimitedTool implements Tool {
  name = 'rate_limited';
  description = 'A tool with rate limiting';

  private rateLimiter: RateLimiter;

  constructor(rateLimiter: RateLimiter) {
    this.rateLimiter = rateLimiter;
  }

  async execute(input: unknown, env: Bindings): Promise<unknown> {
    // Check rate limit
    const allowed = await this.rateLimiter.check('tool:rate_limited');

    if (!allowed) {
      throw new Error('Rate limit exceeded');
    }

    // Execute tool
    // ...
  }
}
```

## Tool Security Considerations

When adding new tools, consider these security aspects:

### Input Validation

Always validate tool inputs to prevent injection attacks:

```typescript
// Validate input
if (typeof input !== 'object' || input === null) {
  throw new Error('Invalid input: expected object');
}

const { text, targetLanguage } = input as { text: string; targetLanguage: string };

if (!text) {
  throw new Error('Invalid input: missing text');
}

if (!targetLanguage) {
  throw new Error('Invalid input: missing targetLanguage');
}

// Validate text length to prevent abuse
if (text.length > this.config.maxTextLength) {
  throw new Error(`Text too long: maximum length is ${this.config.maxTextLength} characters`);
}

// Validate target language
if (!this.config.supportedLanguages.includes(targetLanguage)) {
  throw new Error(`Unsupported target language: ${targetLanguage}`);
}
```

### Output Sanitization

Sanitize tool outputs to prevent injection attacks:

```typescript
// Sanitize output
const sanitizedOutput = sanitizeOutput(rawOutput);

function sanitizeOutput(output: string): string {
  // Remove potentially harmful content
  return output
    .replace(/[<>]/g, '') // Remove HTML tags
    .trim();
}
```

### Access Control

Implement access control to restrict tool usage:

```typescript
export class RestrictedTool implements Tool {
  name = 'restricted';
  description = 'A tool with access restrictions';

  private allowedRoles: string[];

  constructor(allowedRoles: string[]) {
    this.allowedRoles = allowedRoles;
  }

  async execute(input: unknown, env: Bindings, context: ExecutionContext): Promise<unknown> {
    // Check user role
    const userRole = context.user?.role;

    if (!userRole || !this.allowedRoles.includes(userRole)) {
      throw new Error('Access denied: insufficient permissions');
    }

    // Execute tool
    // ...
  }
}
```

## Best Practices for Tool Development

1. **Single Responsibility**: Each tool should have a single, well-defined responsibility.

2. **Clear Documentation**: Provide clear documentation for each tool, including its purpose, inputs, and outputs.

3. **Robust Error Handling**: Implement robust error handling to gracefully handle failures.

4. **Input Validation**: Validate all inputs to prevent injection attacks and ensure correct operation.

5. **Output Sanitization**: Sanitize outputs to prevent injection attacks in the LLM.

6. **Comprehensive Testing**: Write comprehensive tests for each tool to ensure correct behavior.

7. **Performance Optimization**: Optimize tool performance to minimize latency.

8. **Resource Management**: Implement resource management to prevent abuse.

9. **Observability**: Add logging and metrics to monitor tool usage and performance.

10. **Security Considerations**: Consider security implications of tool functionality.

## Conclusion

Adding new tools to the Chat RAG Graph solution is a powerful way to extend its capabilities. By following the patterns and best practices outlined in this guide, you can create tools that integrate seamlessly with the system and provide valuable functionality to users.

For more information on extending the system, see the [Extending the Graph](./extending-graph.md) guide.
