# Ingestor Service

The Ingestor Service is responsible for collecting data from various platforms, including Telegram. It provides APIs for retrieving messages, media, and source information.

## Telegram Integration

The Ingestor Service now integrates with the Telegram Authentication Service to securely access and use Telegram sessions for data collection. This integration allows the Ingestor Service to:

1. Retrieve active sessions for a user
2. Handle session expiration or errors
3. Refresh sessions when needed
4. Use the sessions for data collection

### Architecture

The integration uses Cloudflare service bindings for direct RPC-style communication:

```
┌─────────────────┐      ┌───────────────────────┐
│                 │      │                       │
│ Ingestor Service│◄────►│ Telegram Auth Service │
│                 │      │                       │
└────────┬────────┘      └───────────────────────┘
         │                 Service Binding
         │                 (Direct RPC calls)
         │
         ▼
┌─────────────────┐
│                 │
│  Telegram API   │
│                 │
└─────────────────┘
```

### Components

1. **Telegram Auth Client**: A client library for interacting with the Telegram Authentication Service using service bindings
2. **Telegram Service**: A service for using authenticated sessions to collect data from Telegram
3. **Telegram Controller**: A controller for handling Telegram-related API endpoints

### API Endpoints

- `GET /api/telegram/messages/:userId/:source`: Get messages from a Telegram channel or chat
- `GET /api/telegram/media/:userId/:source`: Get media from a Telegram channel or chat
- `GET /api/telegram/source/:userId/:source`: Get information about a Telegram channel or chat

### Configuration

The integration requires the following environment variables to be set in the `wrangler.toml` file or through the Cloudflare dashboard:

- `TELEGRAM_API_ID`: Your Telegram API ID (from my.telegram.org)
- `TELEGRAM_API_HASH`: Your Telegram API Hash (from my.telegram.org)
- `TELEGRAM_SERVICE_ID`: The service ID for identifying this service to the Telegram Authentication Service
- `TELEGRAM_MAX_RETRIES`: Maximum number of retries for API calls (default: 3)
- `TELEGRAM_RETRY_DELAY`: Delay between retries in milliseconds (default: 2000)
- `TELEGRAM_SESSION_CACHE_TTL`: Session cache TTL in milliseconds (default: 300000)

Additionally, the service requires a service binding to the Telegram Authentication Service, which is configured in the `wrangler.toml` file:

```toml
[[services]]
binding = "TELEGRAM_AUTH"
service = "auth-telegram"
```

### Security Considerations

The integration follows these security best practices:
1. **Secure Session Handling**: Sessions are securely stored and accessed through the Telegram Authentication Service
2. **Service Bindings**: Cloudflare service bindings provide secure, direct communication between services
3. **Error Handling**: Proper error handling and logging for security-related issues
4. **Retry Logic**: Intelligent retry logic with exponential backoff for handling transient errors
5. **Session Refresh**: Automatic session refresh when sessions expire
5. **Session Refresh**: Automatic session refresh when sessions expire

### Example Usage

```typescript
// Example: Using the Telegram Service to collect messages
import { TelegramAuthClient } from './clients/telegram-auth-client';
import { TelegramService } from './services/telegram-service';

// Initialize the Telegram Auth Client with service binding
const telegramAuthClient = new TelegramAuthClient({
  telegramAuth: env.TELEGRAM_AUTH, // Service binding
  serviceId: 'ingestor-service',
  retryAttempts: 3,
  retryDelay: 2000
});

// Initialize the Telegram Service
const telegramService = new TelegramService({
  telegramApiId: 12345,
  telegramApiHash: 'your-api-hash',
  authClient: telegramAuthClient
});

// Collect messages from a channel
const messages = await telegramService.collectMessages(
  userId,
  'channel_username',
  { limit: 100 }
);
```

## Development

### Installation

```bash
# Install dependencies
pnpm install
```

### Running Locally

```bash
# Run in development mode
pnpm dev
```

### Building

```bash
# Build the service
pnpm build
```

### Deployment

```bash
# Deploy to Cloudflare Workers
pnpm deploy
```

## Testing the Integration

To test the integration, you can use the following steps:

1. Ensure the Telegram Authentication Service is running and accessible
2. Configure the environment variables and service bindings in the `wrangler.toml` file
3. Run the Ingestor Service locally with `pnpm dev`
4. Run the Telegram Auth Service locally with `pnpm dev` in a separate terminal
5. Use the API endpoints to collect data from Telegram

Example API call:

```bash
curl -X GET "http://localhost:8787/api/telegram/messages/123/telegram_channel"
```

This will retrieve messages from the specified Telegram channel using the session for user ID 123.