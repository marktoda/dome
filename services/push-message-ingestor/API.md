# Push Message Ingestor API Documentation

This document provides detailed information about the API endpoints exposed by the Push Message Ingestor service.

## Base URL

When deployed, the service is accessible at:

- Production: `https://push-message-ingestor.your-domain.workers.dev`
- Staging: `https://push-message-ingestor-staging.your-domain.workers.dev`
- Local development: `http://localhost:8787`

## Authentication

Currently, the API endpoints do not require authentication. Future versions will implement authentication using Cloudflare Access or API tokens.

## Common Response Format

All API endpoints return responses in a standardized JSON format:

### Success Response

```json
{
  "success": true,
  "data": {
    // Response data specific to the endpoint
  }
}
```

### Error Response

```json
{
  "success": false,
  "correlationId": "unique-correlation-id",
  "error": {
    "code": "ERROR_CODE",
    "message": "Detailed error message",
    "details": {
      // Additional error details when available
    }
  }
}
```

## API Endpoints

### Service Information

#### `GET /`

Returns basic information about the service.

**Request Parameters:** None

**Response:**

```json
{
  "success": true,
  "data": {
    "message": "Hello from push-message-ingestor service!",
    "service": {
      "name": "push-message-ingestor",
      "version": "0.1.0",
      "environment": "development"
    },
    "description": "Service for ingesting messages from various platforms and publishing them to a queue"
  }
}
```

### Health Check

#### `GET /health`

Provides health status information about the service.

**Request Parameters:** None

**Response:**

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2025-04-15T20:55:00.000Z",
    "service": "push-message-ingestor",
    "version": "0.1.0",
    "environment": "development"
  }
}
```

### Telegram Messages

#### `POST /publish/telegram/messages`

Publishes a batch of Telegram messages to the queue for further processing.

**Request Body:**

```json
{
  "messages": [
    {
      "id": "unique-message-id",
      "timestamp": "2025-04-15T20:55:00.000Z",
      "platform": "telegram",
      "content": "Hello, world!",
      "metadata": {
        "chatId": "123456789",
        "messageId": "987654321",
        "fromUserId": "12345",
        "fromUsername": "user123",
        "replyToMessageId": "54321",
        "forwardFromMessageId": "67890",
        "forwardFromChatId": "13579",
        "mediaType": "photo",
        "mediaUrl": "https://example.com/photo.jpg"
      }
    }
    // Additional messages...
  ]
}
```

**Required Fields:**

| Field                | Type   | Description                                        |
| -------------------- | ------ | -------------------------------------------------- |
| `id`                 | string | Unique identifier for the message                  |
| `timestamp`          | string | ISO 8601 timestamp of when the message was created |
| `platform`           | string | Must be "telegram" for this endpoint               |
| `content`            | string | Text content of the message (required if no media) |
| `metadata.chatId`    | string | Telegram chat ID where the message was sent        |
| `metadata.messageId` | string | Telegram message ID                                |

**Optional Fields:**

| Field                           | Type   | Description                                  |
| ------------------------------- | ------ | -------------------------------------------- |
| `metadata.fromUserId`           | string | Telegram user ID of the sender               |
| `metadata.fromUsername`         | string | Telegram username of the sender              |
| `metadata.replyToMessageId`     | string | ID of the message this is replying to        |
| `metadata.forwardFromMessageId` | string | ID of the original message if forwarded      |
| `metadata.forwardFromChatId`    | string | Chat ID of the original message if forwarded |
| `metadata.mediaType`            | string | Type of media (photo, video, document, etc.) |
| `metadata.mediaUrl`             | string | URL to the media content                     |

**Success Response:**

```json
{
  "success": true,
  "data": {
    "message": "Successfully published 1 messages to the queue",
    "count": 1
  }
}
```

**HTTP Status Code:** 201 Created

**Error Responses:**

1. Invalid request body:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid message batch: Messages array is required",
    "correlationId": "d8e8fca2-dc1b-4c7e-9d40-a9a0c3a7b1c9"
  }
}
```

2. Invalid message format:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid messages at indexes: 0, 2. Message at index 0: Message ID is required, Platform must be \"telegram\". Message at index 2: Chat ID is required in metadata",
    "correlationId": "d8e8fca2-dc1b-4c7e-9d40-a9a0c3a7b1c9",
    "details": {
      "errors": [
        {
          "index": 0,
          "errors": [
            { "path": ["id"], "message": "Message ID is required" },
            { "path": ["platform"], "message": "Platform must be \"telegram\"" }
          ]
        },
        {
          "index": 2,
          "errors": [
            { "path": ["metadata", "chatId"], "message": "Chat ID is required in metadata" }
          ]
        }
      ]
    }
  }
}
```

3. Server error:

```json
{
  "success": false,
  "correlationId": "d8e8fca2-dc1b-4c7e-9d40-a9a0c3a7b1c9",
  "error": {
    "code": "QUEUE_ERROR",
    "message": "Error publishing messages: Failed to connect to queue"
  }
}
```

## Error Handling

### Error Codes

The service uses the following error codes:

| Error Code            | HTTP Status | Description                                        |
| --------------------- | ----------- | -------------------------------------------------- |
| `VALIDATION_ERROR`    | 400         | The request body or message format is invalid      |
| `SERVER_ERROR`        | 500         | An internal server error occurred                  |
| `QUEUE_ERROR`         | 500         | Error publishing to the queue                      |
| `NOT_FOUND`           | 404         | The requested resource was not found               |
| `METHOD_NOT_ALLOWED`  | 405         | The HTTP method is not supported for this endpoint |
| `RATE_LIMIT_EXCEEDED` | 429         | Too many requests in a short time period           |

### Error Response Format

All error responses follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Detailed error message",
    "correlationId": "unique-correlation-id",
    "details": {
      // Additional error details when available
    }
  }
}
```

### Environment-Specific Error Handling

The service implements different error handling behavior based on the environment:

#### Development Environment

In development environments, error responses include:

- Detailed error messages
- Stack traces (for server errors)
- Comprehensive error details
- Original error information

This helps developers quickly identify and fix issues during development.

#### Production Environment

In production environments, error responses are sanitized to prevent information leakage:

- Generic error messages for server errors
- No stack traces or internal details
- Limited error details for non-validation errors
- Sensitive information is automatically redacted

This ensures that no sensitive information is exposed to clients while still providing useful error information.

### Validation Errors

Validation errors include detailed information about what went wrong:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid messages at indexes: 0, 2",
    "correlationId": "d8e8fca2-dc1b-4c7e-9d40-a9a0c3a7b1c9",
    "details": {
      "errors": [
        {
          "index": 0,
          "errors": [
            { "path": ["id"], "message": "Message ID is required" },
            { "path": ["platform"], "message": "Platform must be \"telegram\"" }
          ]
        },
        {
          "index": 2,
          "errors": [
            { "path": ["metadata", "chatId"], "message": "Chat ID is required in metadata" }
          ]
        }
      ]
    }
  }
}
```

This detailed validation information is provided in both development and production environments to help clients fix their requests.

## Rate Limiting

The service implements rate limiting to prevent abuse. By default, clients are limited to 100 requests per minute.

When a rate limit is exceeded, the service returns a 429 Too Many Requests response with the following headers:

| Header                  | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `X-RateLimit-Limit`     | Maximum number of requests allowed in the time window   |
| `X-RateLimit-Remaining` | Number of requests remaining in the current time window |
| `X-RateLimit-Reset`     | ISO 8601 timestamp when the rate limit will reset       |

**Rate Limit Exceeded Response:**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later",
    "correlationId": "d8e8fca2-dc1b-4c7e-9d40-a9a0c3a7b1c9",
    "details": {
      "retryAfter": 30
    }
  }
}
```

## Pagination

For endpoints that return large collections of data, the service supports pagination using the following query parameters:

| Parameter | Description              | Default | Maximum |
| --------- | ------------------------ | ------- | ------- |
| `limit`   | Number of items per page | 100     | 1000    |
| `page`    | Page number (1-based)    | 1       | -       |

Paginated responses include pagination metadata:

```json
{
  "success": true,
  "data": {
    "items": [
      // Array of items
    ],
    "pagination": {
      "totalItems": 250,
      "totalPages": 3,
      "currentPage": 1,
      "pageSize": 100,
      "hasNextPage": true,
      "hasPreviousPage": false
    }
  }
}
```

## Request Tracing

All requests are assigned a unique correlation ID for tracing. This ID is included in:

1. Response headers as `X-Correlation-ID`
2. Error responses in the `correlationId` field
3. Server logs for debugging
4. Throughout all asynchronous operations in the service

The correlation ID provides end-to-end traceability for each request, making it easier to debug issues and monitor performance. This is particularly useful in distributed systems where a single request may trigger multiple operations across different services.

### Correlation ID Propagation

The service ensures that correlation IDs are consistently propagated through all asynchronous operations:

1. When a request is received, a unique correlation ID is generated (or extracted from the request headers)
2. This ID is stored in the request context and added to response headers
3. The ID is passed to all service methods and utility functions
4. For batch operations, the ID is propagated to each batch processing function
5. All log entries include the correlation ID for easy filtering and tracing

### Custom Correlation IDs

You can provide your own correlation ID by including the `X-Correlation-ID` header in your request. This is useful for tracing requests across multiple services in your infrastructure.

Example:

```bash
curl -X POST https://push-message-ingestor.your-domain.workers.dev/publish/telegram/messages \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: your-custom-correlation-id" \
  -d '{"messages":[...]}'
```

## Versioning

The current API version is v1 (implicit in the URL). Future versions may include an explicit version in the URL path (e.g., `/v2/publish/telegram/messages`).

## Future Endpoints

The following endpoints are planned for future releases:

### WebSocket Connection

```
GET /ws
```

Establishes a WebSocket connection for real-time message ingestion.

### Authentication

```
POST /auth/token
```

Generates an authentication token for use with the API.

### Additional Platforms

```
POST /publish/slack/messages
POST /publish/discord/messages
```

Endpoints for publishing messages from other platforms.
