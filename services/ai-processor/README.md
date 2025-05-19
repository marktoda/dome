# AI Processor Service

This service processes content from the NEW_CONTENT queue, extracts metadata using LLM, and publishes results to the ENRICHED_CONTENT queue. It also provides RPC functions for reprocessing content.

## Features

- Processes different content types (notes, code, articles) with specialized prompts
- Extracts metadata like titles, summaries, todos, and topics
- Handles errors gracefully with fallback responses
- Provides RPC functions for reprocessing specific content or all failed content
- Robust JSON parsing with fallback mechanisms for malformed LLM responses

## JSON Parsing Improvements

The service includes enhanced JSON parsing capabilities to handle various edge cases in LLM responses:

1. **Sanitization of common JSON syntax errors**:

   - Fixing trailing commas in arrays and objects
   - Adding missing commas between array elements or object properties
   - Quoting unquoted property names
   - Converting single quotes to double quotes

2. **Fallback extraction for severely malformed JSON**:

   - When standard parsing fails, the service attempts to extract structured data using regex
   - Extracts key fields like title, summary, todos, and topics even from broken JSON

3. **Enhanced error logging**:
   - Detailed error context including response preview, length, and format
   - Specific error types and messages for better debugging
   - Metrics tracking for different error types

## Usage

### Processing Content

Content is automatically processed when received from the NEW_CONTENT queue.

### Reprocessing Content

To reprocess specific content:

```typescript
// Reprocess by ID
const result = await aiProcessor.reprocess({ id: 'content-id' });

// Reprocess all failed content
const result = await aiProcessor.reprocess({});
```

## Testing

Run tests with:

```bash
pnpm test
```

The test suite includes specific tests for JSON parsing edge cases, including:

- JSON with trailing commas
- JSON with unquoted property names
- JSON with single quotes
- JSON with missing commas
- Severely malformed JSON that requires fallback extraction

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
| -------- | ----------- | -------- | ------- |
| `LOG_LEVEL` | Logging level | No | `info` |
| `VERSION` | Service version | No | `0.1.0` |
| `ENVIRONMENT` | Deployment environment | No | `dev` |
| `SILO` | RPC binding to the Silo service | Yes | - |
| `ENRICHED_CONTENT` | Queue for processed results | Yes | - |
| `TODOS` | Queue for todo tasks | Yes | - |
| `RATE_LIMIT_DLQ` | Dead letter queue for rate-limited content | Yes | - |
| `AI` | Workers AI binding | Yes | - |
