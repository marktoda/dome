# WebSocket Implementation for Chat Service

This document describes the WebSocket implementation for the chat service, which has replaced the previous Server-Sent Events (SSE) approach.

## Overview

The chat service now supports real-time communication through WebSockets, allowing for more efficient bidirectional communication between clients and the server. WebSockets provide several advantages over SSE:

- Lower overhead for persistent connections
- True bidirectional communication
- Better reconnection capabilities
- Native integration with modern web frameworks

## Architecture

The WebSocket implementation follows a similar pattern to the previous SSE approach, but with enhancements for bidirectional communication:

1. **Server-side**: The chat service handles WebSocket upgrades and processes messages
2. **Transformer**: Converts LangGraph stream outputs into WebSocket messages
3. **Client-side**: A dedicated WebSocket client with reconnection and error handling capabilities

## Message Types

WebSocket messages use a standardized format:

```typescript
interface WebSocketMessage {
  type: MessageType;
  data: Record<string, any>;
}

enum MessageType {
  TEXT = 'text',
  SOURCES = 'sources',
  WORKFLOW_STEP = 'workflow_step',
  FINAL = 'final',
  ERROR = 'error',
  END = 'end',
}
```

## Server Implementation

### Handling WebSocket Connections

The main service handles WebSocket upgrade requests:

```typescript
private handleWebSocketUpgrade(request: Request, env: Env, ctx: ExecutionContext): Response {
  // Get URL query parameters
  const url = new URL(request.url);
  const requestType = url.searchParams.get('type') || 'new_chat';

  // Create WebSocket pair
  const { 0: client, 1: server } = new WebSocketPair();

  // Accept the WebSocket connection
  server.accept();

  // Set up message handler
  server.addEventListener('message', (event) => {
    // Parse the message as JSON
    const message = JSON.parse(event.data as string);

    // Handle the message based on type
    if (message.type === 'new_chat' || message.type === 'resume_chat') {
      // Handle the chat request
      handleWebSocketConnection(env, this.services, server, message);
    }
  });

  // Return the client end of the WebSocket
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
```

### Transforming LangGraph Output

The WebSocket transformer converts LangGraph stream data into WebSocket messages:

```typescript
export async function transformToWebSocket(
  stream: any,
  startTime: number,
  webSocket: WebSocket,
): Promise<void> {
  // Process each event from the LangGraph stream
  for await (const event of stream) {
    // Handle different event types
    if (event.event === 'on_chat_model_stream') {
      // Extract the token chunk and send text message
      const chunk = event.data?.chunk;
      if (chunk && chunk.content) {
        accumulatedText += chunk.content;

        const message: WebSocketMessage = {
          type: MessageType.TEXT,
          data: { text: accumulatedText },
        };

        webSocket.send(JSON.stringify(message));
      }
    }
    // Handle other event types...
  }
}
```

## Client Implementation

The WebSocket client provides a simple interface with robust connection handling:

```typescript
export class WebSocketClient {
  async generateChatResponse(request: ChatRequest, callbacks: WebSocketCallbacks): Promise<void> {
    // Validate request
    const validatedRequest = chatRequestSchema.parse(request);

    // Store the callbacks
    this.callbackHandlers = callbacks;

    // Connect to the WebSocket
    await this.connect(this.getWebSocketUrl('new_chat'));

    // Send the initial message
    this.sendMessage({
      type: 'new_chat',
      ...validatedRequest,
    });
  }

  // Reconnection logic with exponential backoff
  private attemptReconnect(wsUrl: string): void {
    // Calculate backoff delay with jitter
    const baseDelay = Math.min(
      this.options.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
      this.options.maxReconnectDelayMs,
    );

    const jitter = baseDelay * 0.3 * (Math.random() - 0.5);
    const delay = Math.floor(baseDelay + jitter);

    // Schedule reconnection
    this.reconnectTimeout = setTimeout(() => {
      this.connect(wsUrl).catch(error => {
        // Handle reconnection failure
      });
    }, delay);
  }
}
```

## Usage Examples

### Server-side

The chat service will automatically detect WebSocket upgrade requests and handle them appropriately.

### Client-side

```typescript
import { createWebSocketClient, WebSocketCallbacks } from '@dome/chat';

// Create a WebSocket client
const wsClient = createWebSocketClient('https://api.example.com');

// Define callback handlers
const callbacks: WebSocketCallbacks = {
  onText: text => {
    console.log('Received text:', text);
    // Update UI with text
  },
  onSources: sources => {
    console.log('Received sources:', sources);
    // Display sources in UI
  },
  onWorkflowStep: step => {
    console.log('Current workflow step:', step);
    // Update progress indicator
  },
  onError: error => {
    console.error('Error:', error);
    // Display error message
  },
  onEnd: () => {
    console.log('Chat session ended');
    // Clean up UI
  },
};

// Start a chat session
await wsClient.generateChatResponse(
  {
    userId: 'user123',
    messages: [{ role: 'user', content: 'Hello, how can you help me?' }],
    options: { enhanceWithContext: true },
  },
  callbacks,
);

// Close the connection when done
wsClient.close();
```

## Error Handling

The WebSocket implementation includes comprehensive error handling:

1. **Connection errors**: Automatic reconnection with exponential backoff
2. **Message parsing errors**: Graceful error reporting
3. **Stream processing errors**: Error events sent to the client

## Performance Considerations

- WebSockets maintain a persistent connection, reducing the overhead of multiple HTTP requests
- The implementation includes metrics for monitoring connection success rates and latency
- Reconnection logic prevents overwhelming the server during outages
