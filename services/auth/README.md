# Auth Service

Authentication service for Dome API.

## Overview

This service provides authentication functionality for the Dome ecosystem, including:

- User registration
- User login/logout
- Token validation
- Role-based access control

## API Endpoints

### POST /register

Register a new user.

**Request:**

```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe" // optional
}
```

**Response:**

```json
{
  "success": true,
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user",
    "createdAt": "2025-04-30T00:00:00.000Z",
    "updatedAt": "2025-04-30T00:00:00.000Z"
  }
}
```

### POST /login

Login a user and get an authentication token.

**Request:**

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**

```json
{
  "success": true,
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user",
    "createdAt": "2025-04-30T00:00:00.000Z",
    "updatedAt": "2025-04-30T00:00:00.000Z"
  },
  "token": "jwt-token",
  "expiresIn": 86400
}
```

### POST /validate

Validate a token and get the user information.

**Headers:**

```
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user",
    "createdAt": "2025-04-30T00:00:00.000Z",
    "updatedAt": "2025-04-30T00:00:00.000Z"
  }
}
```

### POST /logout

Invalidate a token.

**Headers:**

```
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

## Development

### Setup

1. Install dependencies:

```bash
pnpm install
```

2. Start the development server:

```bash
pnpm run dev
```

### Deployment

Deploy to Cloudflare Workers:

```bash
pnpm run deploy
```

## Integration with dome-api

The auth service provides client libraries for integration with other services. To integrate with dome-api:

1. Add the auth service as a dependency in dome-api's package.json:

```json
{
  "dependencies": {
    "@dome/auth": "workspace:*"
  }
}
```

2. Update dome-api's wrangler.toml to add the service binding:

```toml
[[services]]
binding = "AUTH"
service = "auth"
```

3. Use the auth middleware in dome-api to protect routes:

```typescript
import { createAuthMiddleware } from '@dome/auth/middleware';
import { createAuthService } from '@dome/auth/services';

// Create auth service
const authService = createAuthService(env);

// Create auth middleware
const authMiddleware = createAuthMiddleware(authService);

// Apply middleware to protected routes
app.use('/api/*', authMiddleware);
```

## Database Schema

The service uses a D1 database with the following schema:

- `users`: Stores user information
- `token_blacklist`: Stores invalidated tokens

See `migrations/0000_create_auth_tables.sql` for the complete schema.
