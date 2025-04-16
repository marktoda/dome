# Push Message Ingestor Implementation Plan

This document outlines the implementation details for the push-message-ingestor service.

## Service Overview

The push-message-ingestor service is responsible for accepting messages from various platforms and publishing them to a queue for further processing. It serves as the entry point for external messages into the system.

## Architecture

The service follows a clean architecture pattern with the following components:

1. **Models**: Define the data structures for messages
2. **Validators**: Validate incoming message data
3. **Services**: Handle business logic for message processing
4. **Controllers**: Handle HTTP requests and responses
5. **Routes**: Define API endpoints

## Implementation Details

### Directory Structure

```
services/push-message-ingestor/
├── src/
│   ├── index.ts                  # Main entry point
│   ├── types.ts                  # Type definitions
│   ├── models/
│   │   ├── message.ts            # Message models
│   │   └── validators.ts         # Message validators
│   ├── services/
│   │   └── messageService.ts     # Message service
│   └── controllers/
│       └── messageController.ts  # Message controller
├── wrangler.toml                 # Wrangler configuration
├── package.json                  # Package configuration
├── tsconfig.json                 # TypeScript configuration
└── README.md                     # Documentation
```

### Components

#### Models

The `models/message.ts` file defines the data structures for messages:

- `BaseMessage`: Base interface for all messages
- `TelegramMessage`: Interface for Telegram messages
- `MessageBatch`: Interface for batches of messages

#### Validators

The `models/validators.ts` file contains functions to validate message data:

- `validateTelegramMessage`: Validates a single Telegram message
- `validateTelegramMessageBatch`: Validates a batch of Telegram messages

#### Services

The `services/messageService.ts` file implements the business logic for message processing:

- `MessageService`: Service for handling message operations
  - `publishMessage`: Publishes a single message to the queue
  - `publishMessages`: Publishes multiple messages to the queue
  - `publishTelegramMessages`: Publishes a batch of Telegram messages to the queue

#### Controllers

The `controllers/messageController.ts` file handles HTTP requests and responses:

- `MessageController`: Controller for handling message-related API endpoints
  - `publishTelegramMessages`: Handles the publish Telegram messages endpoint

#### Routes

The `index.ts` file defines the API endpoints:

- `GET /`: Returns basic service information
- `GET /health`: Health check endpoint
- `POST /publish/telegram/messages`: Publishes a batch of Telegram messages to the queue

### Queue Integration

The service integrates with Cloudflare Queues to publish messages:

1. The `wrangler.toml` file defines the queue binding:

   ```toml
   [[queues.producers]]
   queue = "rawmessages"
   binding = "RAW_MESSAGES_QUEUE"
   ```

2. The `MessageService` uses the queue binding to publish messages:
   ```typescript
   await this.queueBinding.send(message);
   ```

## Future Extensions

The service is designed to be extended to support additional platforms:

1. Create a new message model for the platform (e.g., `SlackMessage`)
2. Implement validators for the new message type
3. Add a new endpoint for the platform (e.g., `/publish/slack/messages`)
4. Update the message service to handle the new message type

## Testing

The service can be tested using the following approaches:

1. **Unit Tests**: Test individual components (validators, services, controllers)
2. **Integration Tests**: Test the API endpoints with mock queue bindings
3. **End-to-End Tests**: Test the service with actual queue integration

## Development and Deployment

### Local Development

```bash
# Install dependencies
pnpm install

# Build the service
pnpm build

# Run in development mode
wrangler dev

# Note: Do not use 'pnpm dev' as it may cause issues with queue bindings
# Always use 'wrangler dev' directly for local development
```

### Deployment

The service can be deployed using Wrangler:

```bash
# Build the service
pnpm build

# Deploy to Cloudflare
wrangler deploy
# or
pnpm deploy
pnpm deploy
```
