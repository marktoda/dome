# Telegram Authentication Service

This service provides authentication with Telegram using the MTProto protocol. It exposes methods for session management that can be called directly by other services using Cloudflare service bindings.

## Telegram Proxy Service Integration

The auth-telegram Worker now supports integration with the Telegram Proxy Service to solve WebSocket compatibility issues with Cloudflare Workers. This integration provides:

1. Reliable connection to Telegram API through a proxy service
2. Client-side retry and circuit breaker logic for resilience
3. Fallback mechanisms for reliability
4. Enhanced error handling to distinguish between proxy and Telegram errors

## Configuration

The integration with the Telegram Proxy Service can be enabled or disabled using environment variables:

```
USE_TELEGRAM_PROXY=true
TELEGRAM_PROXY_URL=http://telegram-proxy-service
TELEGRAM_PROXY_API_KEY=your-api-key
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `USE_TELEGRAM_PROXY` | Enable or disable the proxy integration | `true` |
| `TELEGRAM_PROXY_URL` | URL of the Telegram Proxy Service | `http://telegram-proxy-service` |
| `TELEGRAM_PROXY_API_KEY` | API key for the Telegram Proxy Service | - |

## Resilience Features

### Retry Logic

The client implements retry logic for transient errors:
- Network errors
- Rate limiting errors
- Temporary service unavailability

The retry mechanism uses exponential backoff with jitter to prevent thundering herd problems.

### Circuit Breaker

The client implements a circuit breaker pattern to prevent cascading failures:
- Tracks failure rates
- Opens the circuit after a threshold of failures
- Implements half-open state for recovery
- Closes the circuit after successful requests

### Fallback Mechanisms

The client includes fallback mechanisms for reliability:
- Falls back to direct Telegram connection if proxy is disabled
- Provides detailed error information for better error handling

## Error Handling

The client provides enhanced error handling to distinguish between different types of errors:
- `NETWORK`: Network connectivity issues
- `RATE_LIMIT`: Rate limiting by Telegram or the proxy service
- `PROXY_SERVICE`: Errors from the proxy service
- `TELEGRAM_API`: Errors from the Telegram API
- `AUTHENTICATION`: Authentication-related errors
- `UNKNOWN`: Other unspecified errors

## Development

### Local Development

For local development, you can set the environment variables in the `.dev.vars` file:

```
USE_TELEGRAM_PROXY=true
TELEGRAM_PROXY_URL=http://localhost:3000
TELEGRAM_PROXY_API_KEY=dev-api-key
```

### Testing

To test the integration, you can run the service with the proxy enabled or disabled:

```bash
# With proxy
wrangler dev

# Without proxy (direct connection)
USE_TELEGRAM_PROXY=false wrangler dev
```

## Deployment

When deploying to production, make sure to set the appropriate environment variables:

```bash
wrangler secret put TELEGRAM_PROXY_API_KEY
```

The `USE_TELEGRAM_PROXY` and `TELEGRAM_PROXY_URL` variables are set in the `wrangler.toml` file for each environment.