# Telegram Authentication Service

This service provides authentication with Telegram using the MTProto protocol, allowing users to authenticate with their Telegram accounts and securely storing session data for use by other services.

## Features

- Send authentication codes to Telegram users
- Verify authentication codes
- Securely store and manage Telegram sessions
- Provide session data to other services
- Track session usage and access
- Revoke sessions

## API Endpoints

### Authentication

- `POST /api/telegram-auth/send-code`: Send authentication code to a phone number
- `POST /api/telegram-auth/verify-code`: Verify authentication code and create session
- `GET /api/telegram-auth/status`: Check authentication status

### Session Management

- `GET /api/telegram-auth/sessions/user/:userId`: Get session for a user (requires API key)
- `GET /api/telegram-auth/sessions/list/:userId`: List all sessions for a user (admin only)
- `DELETE /api/telegram-auth/sessions/:sessionId`: Revoke a session (requires API key)

### Health Check

- `GET /api/telegram-auth/health`: Service health check
- `GET /health`: Service health check (root level)

## Setup

### Prerequisites

- Telegram API ID and API Hash (obtain from https://my.telegram.org/apps)
- Cloudflare Workers account with D1 database
- Node.js and pnpm

### Environment Variables

The following environment variables need to be set in the `wrangler.toml` file or through the Cloudflare dashboard:

- `TELEGRAM_API_ID`: Your Telegram API ID
- `TELEGRAM_API_HASH`: Your Telegram API Hash
- `SESSION_SECRET`: Secret key for session encryption
- `API_KEY`: API key for service-to-service authentication
- `ADMIN_API_KEY`: API key for admin operations

### Database Setup

The service requires a D1 database with the following tables:

1. `telegram_users`: Stores user information
2. `telegram_sessions`: Stores encrypted session data
3. `telegram_session_access_logs`: Tracks session access

Migration scripts are provided in the `migrations` directory.

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

## Integration with Other Services

Other services can integrate with the Telegram Authentication Service using the provided API endpoints. Here's an example of how to get a session for a user:

```typescript
// Example integration in another service
async function getTelegramSession(userId: number) {
  const response = await fetch(`https://your-worker.workers.dev/api/telegram-auth/sessions/user/${userId}`, {
    method: 'GET',
    headers: {
      'Authorization': `ApiKey ${API_KEY}`,
      'X-Service-ID': 'your-service-id',
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data.sessionString;
}
```

## Security Considerations

- All session data is encrypted using AES-256-GCM
- API keys are required for accessing sessions
- Rate limiting is applied to authentication endpoints
- Session access is logged for audit purposes
- Sessions can be revoked if compromised

## License

This project is private and confidential.