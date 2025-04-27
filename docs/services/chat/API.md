# Chat Service API Documentation

This document provides comprehensive documentation for the Chat Service API, including request/response formats, authentication requirements, and usage examples.

## 1. API Overview

The Chat Service provides a conversational AI interface with Retrieval-Augmented Generation (RAG) capabilities. It allows clients to:

- Generate AI responses enhanced with relevant context
- Stream responses in real-time
- Resume existing conversations
- Manage user data and consent

## 2. Authentication and Authorization

### 2.1 Authentication Requirements

All requests to the Chat Service require a user ID to be provided. This is typically passed in the `x-user-id` header when accessing through the Dome API, or directly in the request body when using RPC.

```typescript
// Example header in Dome API
const userId = c.req.header('x-user-id');
if (!userId) {
  return unauthorizedResponse(c, 'User ID is required');
}
```

### 2.2 Authorization Model

The Chat Service implements a simple authorization model:

1. **User Isolation**: Each user can only access their own data
2. **Service Authentication**: Service-to-service calls use Cloudflare Worker bindings
3. **Admin Operations**: Administrative operations require special permissions

## 3. API Endpoints

The Chat Service is primarily accessed through RPC rather than REST endpoints. However, the following logical "endpoints" are available:

### 3.1 Generate Chat Response

Generates a response to a chat message, optionally enhanced with context.

**Method**: RPC `generateChatResponse`

**Request Format**:

```typescript
interface ChatRequest {
  userId: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: number;
  }>;
  options: {
    enhanceWithContext?: boolean;
    maxContextItems?: number;
    includeSourceInfo?: boolean;
    maxTokens?: number;
    temperature?: number;
    modelId?: string;
  };
  stream?: boolean;
  runId?: string;
}
```

**Response Format (Non-Streaming)**:

```typescript
interface ChatResponse {
  response: string;
  sources?: Array<{
    id: string;
    title: string;
    source: string;
    url?: string | null;
    relevanceScore: number;
  }>;
  metadata?: {
    executionTimeMs: number;
    nodeTimings: Record<string, number>;
    tokenCounts: Record<string, number>;
  };
}
```

**Response Format (Streaming)**:

Server-Sent Events (SSE) with the following event types:

- `workflow_step`: Indicates the current processing step

  ```
  event: workflow_step
  data: {"step":"retrieve"}
  ```

- `answer`: Contains generated text (may be incremental)

  ```
  event: answer
  data: {"delta":"This is the response text"}
  ```

- `sources`: Contains attribution information for retrieved documents

  ```
  event: sources
  data: [{"id":"doc1","title":"Document Title","source":"source_name"}]
  ```

- `done`: Indicates processing is complete

  ```
  event: done
  data: {"executionTimeMs":1234}
  ```

- `error`: Contains error information if processing failed
  ```
  event: error
  data: {"message":"An error occurred during processing"}
  ```

**Example Request**:

```typescript
const request = {
  userId: 'user123',
  messages: [
    {
      role: 'system',
      content: 'You are a helpful assistant.',
    },
    {
      role: 'user',
      content: 'What is the capital of France?',
    },
  ],
  options: {
    enhanceWithContext: true,
    maxContextItems: 5,
    includeSourceInfo: true,
    maxTokens: 1000,
  },
  stream: false,
};

const response = await chatClient.generateResponse(request);
```

**Example Response**:

```json
{
  "response": "The capital of France is Paris. Paris is located in the north-central part of the country on the Seine River. It is one of the world's major cultural, financial, and political centers.",
  "sources": [
    {
      "id": "doc123",
      "title": "European Capitals",
      "source": "geography_database",
      "relevanceScore": 0.92
    }
  ],
  "metadata": {
    "executionTimeMs": 1250,
    "nodeTimings": {
      "split_rewrite": 15,
      "retrieve": 350,
      "generate_answer": 885
    },
    "tokenCounts": {
      "originalQuery": 32,
      "retrievedDocs": 512,
      "response": 189
    }
  }
}
```

### 3.2 Resume Chat Session

Resumes an existing chat session from a checkpoint.

**Method**: RPC `resumeChatSession`

**Request Format**:

```typescript
interface ResumeChatRequest {
  runId: string;
  newMessage?: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: number;
  };
}
```

**Response Format**:

Same as the streaming response format for `generateChatResponse`.

**Example Request**:

```typescript
const request = {
  runId: 'chat_session_123456',
  newMessage: {
    role: 'user',
    content: 'Can you provide more details about Paris?',
  },
};

const response = await chatClient.resumeChatSession(request);
```

### 3.3 Get Checkpoint Statistics

Retrieves statistics about stored checkpoints.

**Method**: RPC `getCheckpointStats`

**Request Format**: No parameters

**Response Format**:

```typescript
interface CheckpointStats {
  totalCheckpoints: number;
  activeCheckpoints: number;
  expiredCheckpoints: number;
  averageSizeBytes: number;
  oldestCheckpointAge: number;
}
```

**Example Request**:

```typescript
const stats = await chatClient.getCheckpointStats();
```

**Example Response**:

```json
{
  "totalCheckpoints": 1250,
  "activeCheckpoints": 980,
  "expiredCheckpoints": 270,
  "averageSizeBytes": 8192,
  "oldestCheckpointAge": 86400
}
```

### 3.4 Cleanup Checkpoints

Cleans up expired checkpoints.

**Method**: RPC `cleanupCheckpoints`

**Request Format**: No parameters

**Response Format**:

```typescript
interface CleanupResult {
  deletedCount: number;
}
```

**Example Request**:

```typescript
const result = await chatClient.cleanupCheckpoints();
```

**Example Response**:

```json
{
  "deletedCount": 270
}
```

### 3.5 Delete User Data

Deletes all data associated with a user.

**Method**: RPC `deleteUserData`

**Request Format**:

```typescript
interface DeleteUserDataRequest {
  userId: string;
}
```

**Response Format**:

```typescript
interface DeleteUserDataResponse {
  deletedCount: number;
}
```

**Example Request**:

```typescript
const result = await chatClient.deleteUserData('user123');
```

**Example Response**:

```json
{
  "deletedCount": 15
}
```

### 3.6 Record User Consent

Records user consent for data retention.

**Method**: RPC `recordConsent`

**Request Format**:

```typescript
interface RecordConsentRequest {
  userId: string;
  dataCategory: string;
  durationDays: number;
}
```

**Response Format**:

```typescript
interface RecordConsentResponse {
  success: boolean;
}
```

**Example Request**:

```typescript
const result = await chatClient.recordConsent('user123', 'conversation_history', 90);
```

**Example Response**:

```json
{
  "success": true
}
```

## 4. Request Validation

All requests to the Chat Service are validated using Zod schemas:

```typescript
export const chatRequestSchema = z.object({
  stream: z.boolean().optional().default(true),
  userId: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      timestamp: z.number().optional(),
    }),
  ),
  options: z.object({
    enhanceWithContext: z.boolean().optional().default(true),
    maxContextItems: z.number().optional().default(5),
    includeSourceInfo: z.boolean().optional().default(true),
    maxTokens: z.number().optional().default(1000),
    temperature: z.number().optional(),
    modelId: z.string().optional(),
  }),
  runId: z.string().optional(),
});
```

Validation errors result in a 400 Bad Request response with details about the validation failure.

## 5. Error Handling

### 5.1 Error Response Format

Error responses follow a consistent format:

```typescript
interface ErrorResponse {
  error: {
    message: string;
    code: string;
    details?: any;
  };
}
```

### 5.2 Common Error Codes

| Code                   | Description               | HTTP Status | Cause                                |
| ---------------------- | ------------------------- | ----------- | ------------------------------------ |
| `validation_error`     | Request validation failed | 400         | Invalid request format or parameters |
| `authentication_error` | Authentication failed     | 401         | Missing or invalid user ID           |
| `authorization_error`  | Authorization failed      | 403         | Insufficient permissions             |
| `not_found`            | Resource not found        | 404         | Requested resource does not exist    |
| `rate_limit_exceeded`  | Rate limit exceeded       | 429         | Too many requests                    |
| `processing_error`     | Error during processing   | 500         | Error in the processing pipeline     |
| `service_unavailable`  | Service unavailable       | 503         | Dependent service unavailable        |

### 5.3 Error Handling Example

```typescript
try {
  const response = await chatClient.generateResponse(request);
  return successResponse(c, { response });
} catch (error) {
  if (error instanceof ValidationError) {
    return validationErrorResponse(c, error.message);
  } else if (error instanceof AuthenticationError) {
    return unauthorizedResponse(c, error.message);
  } else {
    logger.error({ err: error }, 'Unexpected error in chat controller');
    return internalErrorResponse(c);
  }
}
```

## 6. Rate Limiting

The Chat Service implements rate limiting to prevent abuse:

- **Default Limit**: 60 requests per minute per user
- **Streaming Requests**: Counted as a single request
- **Administrative Operations**: Subject to separate limits

Rate limit exceeded errors return a 429 Too Many Requests response with a Retry-After header.

## 7. Client Implementation

### 7.1 TypeScript Client

The Chat Service provides a TypeScript client for easy integration:

```typescript
import { ChatClient } from '@dome/chat/client';

// Create client instance
const chatClient = new ChatClient(env.CHAT_SERVICE);

// Generate response
const response = await chatClient.generateResponse({
  userId: 'user123',
  messages: [{ role: 'user', content: 'Hello, world!' }],
  options: {
    enhanceWithContext: true,
  },
});

// Stream response
const streamingResponse = await chatClient.streamResponse({
  userId: 'user123',
  messages: [{ role: 'user', content: 'Hello, world!' }],
  options: {
    enhanceWithContext: true,
  },
  stream: true,
});

// Process streaming response
const reader = streamingResponse.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value, { stream: true });
  // Process SSE chunk
}
```

### 7.2 Error Handling in Client

The client should implement proper error handling:

```typescript
try {
  const response = await chatClient.generateResponse(request);
  // Process response
} catch (error) {
  if (error.code === 'validation_error') {
    // Handle validation error
  } else if (error.code === 'rate_limit_exceeded') {
    // Handle rate limiting
    const retryAfter = error.headers?.['retry-after'];
    // Retry after specified delay
  } else {
    // Handle other errors
    console.error('Error generating response:', error);
  }
}
```

## 8. Versioning and Compatibility

### 8.1 API Versioning

The Chat Service API is versioned using the following scheme:

- **Major Version**: Breaking changes
- **Minor Version**: Non-breaking additions
- **Patch Version**: Bug fixes and minor improvements

The current API version is included in the response headers:

```
x-api-version: 1.0.0
```

### 8.2 Backward Compatibility

The Chat Service maintains backward compatibility within the same major version:

- Existing fields will not be removed or changed in incompatible ways
- New optional fields may be added
- Default values may be changed with notice

## 9. Best Practices

### 9.1 Request Optimization

For optimal performance:

1. **Limit Message History**: Include only necessary conversation history
2. **Use Streaming**: Enable streaming for better user experience
3. **Set Appropriate Limits**: Configure `maxContextItems` and `maxTokens` based on needs
4. **Include System Messages**: Use system messages to guide the assistant's behavior

### 9.2 Error Handling

Implement robust error handling:

1. **Validate Locally**: Validate requests before sending
2. **Handle Rate Limiting**: Implement exponential backoff for rate limit errors
3. **Provide Fallbacks**: Have fallback behavior when the service is unavailable
4. **Log Errors**: Log errors with context for troubleshooting

### 9.3 Security Considerations

Follow these security best practices:

1. **Validate User Input**: Sanitize and validate all user input
2. **Protect User IDs**: Treat user IDs as sensitive information
3. **Implement Timeouts**: Set appropriate timeouts for requests
4. **Monitor Usage**: Watch for unusual patterns that might indicate abuse

## 10. Examples

### 10.1 Basic Chat Example

```typescript
// Create client
const chatClient = new ChatClient(env.CHAT_SERVICE);

// Generate response
const response = await chatClient.generateResponse({
  userId: 'user123',
  messages: [
    {
      role: 'system',
      content: 'You are a helpful assistant.',
    },
    {
      role: 'user',
      content: 'What is the capital of France?',
    },
  ],
  options: {
    enhanceWithContext: true,
    maxContextItems: 5,
    includeSourceInfo: true,
  },
});

console.log('Response:', response.response);

if (response.sources && response.sources.length > 0) {
  console.log('Sources:');
  response.sources.forEach(source => {
    console.log(`- ${source.title} (${source.source})`);
  });
}
```

### 10.2 Streaming Example

```typescript
// Create client
const chatClient = new ChatClient(env.CHAT_SERVICE);

// Stream response
const streamingResponse = await chatClient.streamResponse({
  userId: 'user123',
  messages: [
    {
      role: 'user',
      content: 'Write a short poem about Paris.',
    },
  ],
  options: {
    enhanceWithContext: true,
  },
  stream: true,
});

// Process streaming response
const reader = streamingResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let responseText = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });

  // Process complete SSE events
  const events = buffer.split('\n\n');
  buffer = events.pop() || '';

  for (const event of events) {
    if (!event.trim()) continue;

    const lines = event.split('\n');
    const eventType = lines[0].replace('event: ', '');
    const data = JSON.parse(lines[1].replace('data: ', ''));

    if (eventType === 'answer' && data.delta) {
      responseText += data.delta;
      console.log('Received chunk:', data.delta);
    } else if (eventType === 'sources') {
      console.log('Sources:', data);
    } else if (eventType === 'done') {
      console.log('Processing complete in', data.executionTimeMs, 'ms');
    } else if (eventType === 'error') {
      console.error('Error:', data.message);
    }
  }
}

console.log('Final response:', responseText);
```

### 10.3 Resuming a Chat Session

```typescript
// Create client
const chatClient = new ChatClient(env.CHAT_SERVICE);

// Initial request with runId
const initialResponse = await chatClient.streamResponse({
  userId: 'user123',
  messages: [
    {
      role: 'user',
      content: 'Tell me about Paris.',
    },
  ],
  options: {
    enhanceWithContext: true,
  },
  stream: true,
  runId: 'session_' + Date.now(),
});

// Process initial response and extract runId from headers
const runId = initialResponse.headers.get('x-run-id');

// Later, resume the session
const resumedResponse = await chatClient.resumeChatSession({
  runId,
  newMessage: {
    role: 'user',
    content: 'What about its history?',
  },
});

// Process resumed response
// ...
```

## 11. Troubleshooting

### 11.1 Common Issues

| Issue                | Possible Causes                  | Resolution                                  |
| -------------------- | -------------------------------- | ------------------------------------------- |
| Validation Error     | Invalid request format           | Check request against schema                |
| Authentication Error | Missing user ID                  | Ensure user ID is provided                  |
| Rate Limit Exceeded  | Too many requests                | Implement backoff and retry                 |
| Processing Timeout   | Complex query or system overload | Simplify query or retry later               |
| Empty Response       | No relevant context found        | Adjust query or disable context enhancement |

### 11.2 Debugging

For debugging issues:

1. **Enable Verbose Logging**: Set `LOG_LEVEL` to `debug`
2. **Check Response Headers**: Headers contain useful debugging information
3. **Examine Metadata**: Response metadata includes timing and token information
4. **Use Trace IDs**: Trace IDs in headers can be used to correlate logs
