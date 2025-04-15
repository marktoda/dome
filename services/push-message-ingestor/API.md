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
  "error": {
    "code": "ERROR_CODE",
    "message": "Detailed error message"
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
  "status": "ok",
  "timestamp": "2025-04-15T20:55:00.000Z",
  "service": "push-message-ingestor",
  "version": "0.1.0"
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

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the message |
| `timestamp` | string | ISO 8601 timestamp of when the message was created |
| `platform` | string | Must be "telegram" for this endpoint |
| `content` | string | Text content of the message (required if no media) |
| `metadata.chatId` | string | Telegram chat ID where the message was sent |
| `metadata.messageId` | string | Telegram message ID |

**Optional Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `metadata.fromUserId` | string | Telegram user ID of the sender |
| `metadata.fromUsername` | string | Telegram username of the sender |
| `metadata.replyToMessageId` | string | ID of the message this is replying to |
| `metadata.forwardFromMessageId` | string | ID of the original message if forwarded |
| `metadata.forwardFromChatId` | string | Chat ID of the original message if forwarded |
| `metadata.mediaType` | string | Type of media (photo, video, document, etc.) |
| `metadata.mediaUrl` | string | URL to the media content |

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

**Error Responses:**

1. Invalid request body:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid message batch: Messages array is required"
  }
}
```

2. Invalid message format:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid messages at indexes: 0, 2. Message at index 0: Message ID is required, Platform must be \"telegram\". Message at index 2: Chat ID is required in metadata"
  }
}
```

3. Server error:

```json
{
  "success": false,
  "error": {
    "code": "SERVER_ERROR",
    "message": "Error publishing messages: Failed to connect to queue"
  }
}
```

## Error Codes

The service uses the following error codes:

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | The request body or message format is invalid |
| `SERVER_ERROR` | 500 | An internal server error occurred |
| `QUEUE_ERROR` | 500 | Error publishing to the queue |
| `NOT_FOUND` | 404 | The requested resource was not found |
| `METHOD_NOT_ALLOWED` | 405 | The HTTP method is not supported for this endpoint |

## Rate Limiting

The service currently does not implement rate limiting. Future versions may include rate limiting to prevent abuse.

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