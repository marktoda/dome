# Ingestor Service

The Ingestor Service is responsible for collecting data from various platforms, including Telegram. It provides APIs for retrieving messages, media, and source information.

## Telegram Integration

The Ingestor Service integrates with both the Telegram Authentication Service and the Telegram Proxy Service to securely access and efficiently collect data from Telegram. This integration allows the Ingestor Service to:

1. Retrieve active sessions for a user
2. Handle session expiration or errors
3. Refresh sessions when needed
4. Use the sessions for data collection
5. Efficiently poll for new messages
6. Support real-time updates when available

### Architecture

The integration uses Cloudflare service bindings for direct RPC-style communication with the Auth Service and HTTP requests for the Proxy Service:

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
┌─────────────────┐      ┌───────────────────────┐
│                 │      │                       │
│ Telegram Proxy  │◄────►│     Telegram API      │
│    Service      │      │                       │
└─────────────────┘      └───────────────────────┘
         ▲
         │
         │ HTTP/REST API
         │ (With rate limiting)
         │
┌────────┴────────┐
│                 │
│ Ingestor Service│
│                 │
└─────────────────┘
```

### Components

1. **Telegram Auth Client**: A client library for interacting with the Telegram Authentication Service using service bindings
2. **Telegram Proxy Client**: A client library for interacting with the Telegram Proxy Service using HTTP requests
3. **Telegram Service**: A service for using authenticated sessions to collect data directly from Telegram
4. **Telegram Proxy Service**: A service for using the Telegram Proxy Service to efficiently collect data from Telegram
5. **Telegram Controller**: A controller for handling Telegram-related API endpoints

### API Endpoints

- `GET /api/telegram/messages/:userId/:source`: Get messages from a Telegram channel or chat
- `GET /api/telegram/media/:userId/:source`: Get media from a Telegram channel or chat
- `GET /api/telegram/source/:userId/:source`: Get information about a Telegram channel or chat
- `GET /api/telegram/poll/:userId/:source`: Poll for new messages from a Telegram channel or chat

### Configuration

The integration requires the following environment variables to be set in the `wrangler.toml` file or through the Cloudflare dashboard:

#### Telegram Authentication Configuration

- `TELEGRAM_API_ID`: Your Telegram API ID (from my.telegram.org)
- `TELEGRAM_API_HASH`: Your Telegram API Hash (from my.telegram.org)
- `TELEGRAM_SERVICE_ID`: The service ID for identifying this service to the Telegram Authentication Service
- `TELEGRAM_MAX_RETRIES`: Maximum number of retries for API calls (default: 3)
- `TELEGRAM_RETRY_DELAY`: Delay between retries in milliseconds (default: 2000)
- `TELEGRAM_SESSION_CACHE_TTL`: Session cache TTL in milliseconds (default: 300000)

#### Telegram Proxy Service Configuration

- `TELEGRAM_PROXY_ENABLED`: Whether to use the Telegram Proxy Service (default: true)
- `TELEGRAM_PROXY_BASE_URL`: Base URL of the Telegram Proxy Service (default: http://localhost:3000)
- `TELEGRAM_PROXY_API_KEY`: API key for authentication with the Telegram Proxy Service
- `TELEGRAM_PROXY_POLLING_INTERVAL`: Default polling interval in milliseconds (default: 5000)
- `TELEGRAM_PROXY_POLL_TIMEOUT`: Default polling timeout in seconds (default: 10)

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
6. **Rate Limiting**: Client-side rate limiting to prevent API abuse
7. **Jitter**: Added jitter to retry delays to prevent thundering herd problem

### Example Usage

#### Using the Direct Telegram Service

```typescript
// Example: Using the Telegram Service to collect messages directly
import { TelegramAuthClient } from './clients/telegram-auth-client';
import { TelegramService } from './services/telegram-service';

// Initialize the Telegram Auth Client with service binding
const telegramAuthClient = new TelegramAuthClient({
  telegramAuth: env.TELEGRAM_AUTH, // Service binding
  serviceId: 'ingestor-service',
  retryAttempts: 3,
  retryDelay: 2000,
});

// Initialize the Telegram Service
const telegramService = new TelegramService({
  telegramApiId: 12345,
  telegramApiHash: 'your-api-hash',
  authClient: telegramAuthClient,
});

// Collect messages from a channel
const messages = await telegramService.collectMessages(userId, 'channel_username', { limit: 100 });
```

#### Using the Telegram Proxy Service

```typescript
// Example: Using the Telegram Proxy Service to collect messages
import { TelegramAuthClient } from './clients/telegram-auth-client';
import { TelegramProxyClient } from './clients/telegram-proxy-client';
import { TelegramProxyService } from './services/telegram-proxy-service';

// Initialize the Telegram Auth Client with service binding
const telegramAuthClient = new TelegramAuthClient({
  telegramAuth: env.TELEGRAM_AUTH, // Service binding
  serviceId: 'ingestor-service',
  retryAttempts: 3,
  retryDelay: 2000,
});

// Initialize the Telegram Proxy Client
const telegramProxyClient = new TelegramProxyClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key',
  maxRetries: 3,
  retryDelay: 2000,
  pollTimeout: 10,
});

// Initialize the Telegram Proxy Service
const telegramProxyService = new TelegramProxyService({
  telegramApiId: 12345,
  telegramApiHash: 'your-api-hash',
  authClient: telegramAuthClient,
  proxyClient: telegramProxyClient,
  useProxyService: true,
});

// Collect messages from a channel
const messages = await telegramProxyService.collectMessages(userId, 'channel_username', {
  limit: 100,
});

// Poll for new messages
const newMessages = await telegramProxyService.pollMessages(userId, 'channel_username', {
  timeout: 10,
  limit: 50,
});
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

### Testing with Direct Telegram Integration

1. Ensure the Telegram Authentication Service is running and accessible
2. Configure the environment variables and service bindings in the `wrangler.toml` file
3. Set `TELEGRAM_PROXY_ENABLED` to `false` in the `wrangler.toml` file
4. Run the Ingestor Service locally with `pnpm dev`
5. Run the Telegram Auth Service locally with `pnpm dev` in a separate terminal
6. Use the API endpoints to collect data from Telegram

Example API call:

```bash
curl -X GET "http://localhost:8787/api/telegram/messages/123/telegram_channel"
```

This will retrieve messages from the specified Telegram channel using the session for user ID 123.

### Testing with Telegram Proxy Service

1. Ensure the Telegram Authentication Service is running and accessible
2. Ensure the Telegram Proxy Service is running and accessible
3. Configure the environment variables and service bindings in the `wrangler.toml` file
4. Set `TELEGRAM_PROXY_ENABLED` to `true` in the `wrangler.toml` file
5. Set `TELEGRAM_PROXY_BASE_URL` to the URL of your Telegram Proxy Service
6. Set `TELEGRAM_PROXY_API_KEY` to a valid API key for the Telegram Proxy Service
7. Run the Ingestor Service locally with `pnpm dev`
8. Run the Telegram Auth Service locally with `pnpm dev` in a separate terminal
9. Use the API endpoints to collect data from Telegram

Example API calls:

```bash
# Get messages
curl -X GET "http://localhost:8787/api/telegram/messages/123/telegram_channel"

# Poll for new messages
curl -X GET "http://localhost:8787/api/telegram/poll/123/telegram_channel?timeout=10&limit=50"
```

The first call will retrieve messages from the specified Telegram channel using the Telegram Proxy Service.
The second call will poll for new messages with a timeout of 10 seconds and a limit of 50 messages.
