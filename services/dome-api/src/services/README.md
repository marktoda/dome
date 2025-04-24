# Chat Service Refactoring

This document explains the refactoring of the chat service in the dome-api project.

## Why the Refactoring Was Needed

### Streaming Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| **No tokens until the very end** | Creating a custom `TransformStream` when Workers AI already returns a `ReadableStream` of chunks | Return the stream from `env.AI.run()` directly |
| **Random "writer closed" errors** | Timeout could fire after the AI stream finished and closed the writer | Clear the timeout in every exit path and gate `writer.close()` behind `writer.locked` |
| **Nothing arrives on the client** | Missing response headers | Wrap the stream in a Response with proper headers |
| **Slow first token** | Excessive logging for each chunk | Reduced logging frequency and level |

### Structural Issues

- **Huge single class** – The original ChatService handled too many responsibilities
- **Duplicated fallback logic** – "AI unavailable", "timeout", and "test mode" branches appeared multiple times
- **Custom token estimator** – Using `char × 0.25` was brittle
- **Verbose defensive logging** – Excessive try/catch blocks and logging code

## Refactoring Approach

The refactoring split the monolithic ChatService into smaller, focused classes:

```
ChatService
 ├─ PromptBuilder      (token-aware; injects RAG context)
 ├─ LlmClient          (sync + streaming wrappers, single retry/timeout policy)
 └─ SimpleChatService  (minimal implementation example)
```

### Key Improvements

1. **Direct Stream Usage**
   - Now returns the Workers AI stream directly instead of wrapping it in a TransformStream
   - Adds proper headers to the Response

2. **Single Fallback/Timeout Wrapper**
   - Centralized timeout and fallback logic in the LlmClient
   - Consistent error handling across streaming and non-streaming paths

3. **Proper Token Counting**
   - Replaced ad-hoc token math with the `@dqbd/tiktoken` tokenizer
   - More accurate token counting for context truncation

4. **Reduced Logging**
   - Simplified logging with focused, meaningful log entries
   - Reduced per-chunk logging to debug level

5. **Simplified API**
   - Cleaner interfaces between components
   - Better separation of concerns

## Implementation Details

### PromptBuilder

Handles token-aware prompt building and RAG context injection:
- Counts tokens accurately using tiktoken
- Formats context for inclusion in prompts
- Truncates content to fit token limits

### LlmClient

Handles interactions with the AI service:
- Provides unified timeout handling
- Centralizes fallback responses
- Handles test mode consistently
- Returns properly formatted Response objects for streaming

### ChatService

Orchestrates the overall chat process:
- Uses PromptBuilder for context-enhanced prompts
- Uses LlmClient for AI interactions
- Handles high-level error cases

### SimpleChatService

A minimal implementation example that demonstrates the core functionality in about 140 lines of code.

## Usage

The refactored services maintain the same public API, so existing code should continue to work without changes. The controller has been updated to work with the new Response-based streaming approach.