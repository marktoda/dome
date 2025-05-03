# Handling "Thinking" Content in Chat

This document describes how to properly handle "thinking" content in the chat application to prevent content filter errors.

## Overview

When Claude or other AI models generate "thinking" content (content in `<thinking>` tags or marked as reasoning/analysis steps), it may sometimes trigger content filters due to certain patterns or sequences. To address this issue, we've implemented a specialized handling system for thinking content that:

1. Detects when content appears to be "thinking"
2. Sanitizes it to prevent content filter issues
3. Sends it as a different event type in the SSE stream
4. Provides client-side handling utilities

## Server-Side Implementation

The server identifies thinking content and processes it through the `ThinkingHandler` utility:

```typescript
import { processThinkingContent } from './utils/thinkingHandler';

// When receiving content from an LLM:
const processedContent = processThinkingContent(rawContent);
```

The SSE transformer now emits special "thinking" events that are handled differently from regular text:

```
event: thinking
data: {"thinking":"This is thinking content that's been sanitized"}
```

## Client-Side Implementation

To handle thinking content in your UI:

```typescript
import { 
  ThinkingEventHandler, 
  EventType, 
  createThinkingEventHandler 
} from '@dome/chat';

// Create a handler
const eventHandler = createThinkingEventHandler();

// Set up your event source
const eventSource = new EventSource('/api/chat/stream');

// Set up listeners
eventSource.onmessage = (event) => {
  // Generic message handling
};

// Process specific event types
eventSource.addEventListener('thinking', (event) => {
  const thinkingEvent = ThinkingEventHandler.parseSSEMessage('thinking', event.data);
  if (thinkingEvent) {
    eventHandler.processEvent(thinkingEvent);
  }
});

// Subscribe to thinking events
eventHandler.addEventListener(EventType.Thinking, (data) => {
  // Display thinking content in your UI
  thinkingContentElement.textContent = data.thinking;
});
```

## UI Best Practices

When displaying thinking content:

1. Consider using a different style or section of the UI for thinking content
2. Use a monospace font for better readability of logic/code
3. Clearly label it as "Thinking" or "Analysis" 
4. Consider making it collapsible or optional for users
5. If your UI doesn't need to display thinking content, you can simply ignore these events

## Benefits

- Prevents content filter errors
- Provides a clear separation between thinking and final response content
- Enables more transparent AI reasoning for users who want to see it
- Maintains compatibility with existing code through event-based architecture

## Debugging

If you encounter issues with thinking content:

1. Check browser console for any warnings from the `ThinkingEventHandler`
2. Verify that SSE events are being properly parsed
3. Ensure your event listeners are registered correctly
4. Look for content filter error messages that might indicate additional sanitization is needed

For persistent issues, consider logging the raw content from the LLM and the sanitized output to identify patterns that might be triggering filters.