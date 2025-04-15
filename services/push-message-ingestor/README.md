# Push Message Ingestor Service

## Overview

The Push Message Ingestor Service is a Cloudflare Worker that serves as an entry point for external messages into the Communicator system. Unlike the polling-based ingestor service, this service provides endpoints that external systems can push messages to directly.

The service is responsible for:
- Receiving messages pushed from external sources (currently supporting Telegram)
- Validating and normalizing incoming message data
- Publishing validated messages to the `rawmessages` queue for further processing
- Providing a foundation for future message sources and protocols

## Features

- **Multi-platform Support**: Designed to accept messages from various platforms (currently supports Telegram)
- **Message Validation**: Validates message format and content before publishing
- **Queue Integration**: Publishes messages to the `rawmessages` Cloudflare Queue
- **Batch Processing**: Supports publishing multiple messages in a single request
- **Error Handling**: Comprehensive error handling with detailed error messages
- **Extensibility**: Modular architecture for easy addition of new message sources

## Installation and Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS version recommended)
- [pnpm](https://pnpm.io/) package manager
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) for Cloudflare Workers

### Installation

1. Clone the repository and navigate to the service directory:

```bash
# From the repository root
cd services/push-message-ingestor
```

2. Install dependencies:

```bash
pnpm install
```

3. Configure Wrangler:

Ensure your `wrangler.toml` file is properly configured with your Cloudflare account ID and queue bindings. You may need to update the following:

```toml
# wrangler.toml
name = "push-message-ingestor"
account_id = "your-cloudflare-account-id" # Add this line with your account ID

# Queue bindings
[[queues.producers]]
queue = "rawmessages"
binding = "RAW_MESSAGES_QUEUE"
```

## Local Development

### Running the Service Locally

To run the service locally with Wrangler:

```bash
# Start the development server
wrangler dev
```

> **Important**: Always use `wrangler dev` directly for local development, not `pnpm dev`, to ensure proper queue binding support.

The service will be available at `http://localhost:8787` by default.

### Testing

The service includes unit tests and integration test scripts:

```bash
# Run unit tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run integration tests against a local instance
# Option 1: Using the original test script
chmod +x tests/test-scripts.sh
./tests/test-scripts.sh http://localhost:8787

# Option 2: Using the fixed test script (recommended)
chmod +x tests/test-scripts-fixed.sh
./tests/test-scripts-fixed.sh http://localhost:8787

# Option 3: Using the test runner script (easiest)
chmod +x run-tests.sh
./run-tests.sh
```

The test scripts verify all endpoints and test various scenarios:
- Base endpoint (GET /)
- Health check endpoint (GET /health)
- Valid message publishing
- Invalid message validation
- Empty message arrays
- Multiple messages in a single request
- Mixed valid and invalid messages

For more details on testing, see the [tests/README.md](tests/README.md) and [tests/TESTING.md](tests/TESTING.md) files.

#### Recent Test Improvements

The service has been updated to fix several issues:
- Enhanced JSON parsing error handling with detailed error messages
- Improved handling of empty message arrays
- Added request body logging for better debugging
- Created new test scripts with improved JSON payload handling
- Added a simple test runner script (`run-tests.sh`) for easier testing

If you encounter issues with the original test script, try using the fixed version (`test-scripts-fixed.sh`) or the test runner script (`run-tests.sh`).

### Development Workflow

1. Make changes to the source code
2. Run tests to verify functionality
3. Test locally with Wrangler
4. Deploy to staging for integration testing
5. Deploy to production

## Deployment

### Deploying to Cloudflare

To deploy the service to Cloudflare Workers:

```bash
# Build the service
pnpm build

# Deploy to the default environment
wrangler deploy

# Or use the npm script
pnpm deploy

# Deploy to a specific environment
wrangler deploy --env production
```

### Environment Configuration

The service supports different environments through Wrangler:

- **Development**: Default local environment
- **Staging**: For testing before production
- **Production**: Production environment

Environment-specific configuration is defined in `wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "development"

[env.production]
vars = { ENVIRONMENT = "production" }

[env.staging]
vars = { ENVIRONMENT = "staging" }
```

## API Documentation

### Base Endpoints

#### `GET /`

Returns basic service information.

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

#### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-04-15T20:55:00.000Z",
  "service": "push-message-ingestor",
  "version": "0.1.0"
}
```

### Telegram Endpoints

#### `POST /publish/telegram/messages`

Publishes a batch of Telegram messages to the queue.

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
        "mediaType": "photo",
        "mediaUrl": "https://example.com/photo.jpg"
      }
    }
  ]
}
```

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

**Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid message batch: Message ID is required"
  }
}
```

For more detailed API documentation, see the [API.md](API.md) file.

## Error Handling

The service returns standardized error responses:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Detailed error message"
  }
}
```

Common error codes:

- `VALIDATION_ERROR`: Invalid message format or missing required fields
- `SERVER_ERROR`: Internal server error
- `QUEUE_ERROR`: Error publishing to the queue

## Future Extension Points

The service is designed to be extended to support additional platforms and features:

### Adding New Message Sources

To add support for a new message source (e.g., Slack):

1. Create a new message model in `src/models/message.ts`:
   ```typescript
   export interface SlackMessage extends BaseMessage {
     platform: 'slack';
     metadata: {
       channelId: string;
       messageId: string;
       // Other Slack-specific fields
     };
   }
   ```

2. Implement validators in `src/models/validators.ts`:
   ```typescript
   export function validateSlackMessage(message: any): { valid: boolean; errors?: string[] } {
     // Validation logic
   }
   ```

3. Add a new endpoint in `src/index.ts`:
   ```typescript
   app.post("/publish/slack/messages", async (c: any) => {
     const messageController = new MessageController(c.env.RAW_MESSAGES_QUEUE);
     return await messageController.publishSlackMessages(c);
   });
   ```

4. Update the message controller in `src/controllers/messageController.ts`:
   ```typescript
   async publishSlackMessages(c: Context<{ Bindings: Bindings }>): Promise<Response> {
     // Controller logic
   }
   ```

5. Update the message service in `src/services/messageService.ts`:
   ```typescript
   async publishSlackMessages(batch: SlackMessageBatch): Promise<{ success: boolean; error?: string }> {
     // Service logic
   }
   ```

### Implementing WebSocket Support

Future versions of the service will support WebSocket connections for real-time message ingestion:

1. Create a WebSocket controller in `src/controllers/websocketController.ts`
2. Add WebSocket route handling in `src/index.ts`
3. Reuse the existing message validation and queue publishing logic

### Adding Authentication

To add Cloudflare Access authentication:

1. Create an auth service in `src/services/authService.ts`
2. Implement authentication middleware in `src/middleware/authMiddleware.ts`
3. Apply the middleware to protected routes in `src/index.ts`

For more details on the architecture and extension points, see the [architecture.md](architecture.md) file.