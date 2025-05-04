# Dome API Authentication Setup

This document describes how to integrate the authentication service with dome-api.

## Overview

The dome-api now uses a dedicated authentication service to handle user authentication. This separation of concerns:

- Improves security by isolating authentication logic
- Enables centralized user management
- Provides consistent authentication across services
- Simplifies token validation and role-based access control

## Integration Steps

### 1. Add Auth Service Dependency

Update `services/dome-api/package.json` to include the auth service:

```json
{
  "dependencies": {
    "@dome/auth": "workspace:*"
    // other dependencies...
  }
}
```

### 2. Configure Service Binding

Update `services/dome-api/wrangler.toml` to add the auth service binding:

```toml
[[services]]
binding = "AUTH"
service = "auth"
environment = "production" # or appropriate environment
```

### 3. Update Bindings Type

Modify `services/dome-api/src/types.ts` to include the auth service binding:

```typescript
import { AuthBinding } from '@dome/auth/client';

export type Bindings = {
  // existing bindings...
  AUTH: AuthBinding; // Auth service binding
};
```

### 4. Create Auth Middleware

Create a new middleware file `services/dome-api/src/middleware/authMiddleware.ts`:

```typescript
import { Context, Next } from 'hono';
import { getLogger } from '@dome/logging';
import { AuthServiceBinding } from '@dome/auth/client';
import type { Bindings } from '../types';

// Context with authenticated user
export interface AuthContext {
  userId: string;
  userRole: string;
  userEmail: string;
}

// Middleware to authenticate requests
export const authMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: AuthContext }>,
  next: Next,
) => {
  const logger = getLogger().child({ component: 'AuthMiddleware' });
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Missing or invalid Authorization header');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      },
      401,
    );
  }

  try {
    const token = authHeader.slice(7);

    // Create auth service client
    const authServiceUrl = 'https://auth.dome.example.com'; // Replace with actual URL
    const authService = new AuthServiceBinding(authServiceUrl);

    // Validate token
    const { success, user } = await authService.validateToken(token);

    if (!success || !user) {
      logger.warn('Invalid token');
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
          },
        },
        401,
      );
    }

    // Set user info in context
    c.set('userId', user.id);
    c.set('userRole', user.role);
    c.set('userEmail', user.email);

    logger.debug({ userId: user.id }, 'User authenticated');

    // Continue to next middleware/handler
    await next();
  } catch (error) {
    logger.error({ error }, 'Authentication error');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication failed',
        },
      },
      401,
    );
  }
};

// Role-based access control middleware factory
export const createRoleMiddleware = (requiredRoles: string[]) => {
  return async (c: Context<{ Variables: AuthContext }>, next: Next) => {
    const logger = getLogger().child({ component: 'RoleMiddleware' });
    const userRole = c.get('userRole');

    if (!userRole || !requiredRoles.includes(userRole)) {
      logger.warn({ userRole, requiredRoles }, 'Insufficient permissions');
      return c.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions',
          },
        },
        403,
      );
    }

    await next();
  };
};
```

### 5. Replace SimpleAuthMiddleware in dome-api

Update `services/dome-api/src/index.ts` to use the new auth middleware:

```typescript
// Replace this line:
app.use('*', createSimpleAuthMiddleware());

// With these imports:
import { authMiddleware } from './middleware/authMiddleware';

// And these middleware applications:
// Public routes don't need authentication
app.use('/health', responseHandlerMiddleware);
app.use('/', responseHandlerMiddleware);

// All other routes require authentication
app.use('/notes/*', authMiddleware);
app.use('/search/*', authMiddleware);
app.use('/chat/*', authMiddleware);
app.use('/content/*', authMiddleware);
app.use('/ai/*', authMiddleware);

// Then continue with other middleware
app.use('*', responseHandlerMiddleware);
```

### 6. Update userIdMiddleware

Replace the existing `services/dome-api/src/middleware/userIdMiddleware.ts` with:

```typescript
import { Context, Next } from 'hono';
import { getLogger } from '@dome/logging';
import type { Bindings } from '../types';

// User ID context
export interface UserIdContext {
  userId: string;
}

// User ID middleware
export const userIdMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: UserIdContext }>,
  next: Next,
) => {
  // Get the user ID from the auth context (already set by authMiddleware)
  const userId = c.get('userId');

  if (!userId) {
    const logger = getLogger().child({ component: 'UserIdMiddleware' });
    logger.error('Missing userId in context');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      },
      401,
    );
  }

  // Set userId in context for downstream handlers
  c.set('userId', userId);

  await next();
};
```

## User Login Flow

### 1. Login Endpoint

Add a login endpoint to dome-api to proxy authentication requests:

```typescript
// In services/dome-api/src/index.ts

// Auth routes
const authRouter = new Hono();

authRouter.post('/login', async (c: Context<{ Bindings: Bindings }>) => {
  try {
    const { email, password } = await c.req.json();

    // Create auth service client
    const authServiceUrl = 'https://auth.dome.example.com'; // Replace with actual URL
    const authService = new AuthServiceBinding(authServiceUrl);

    // Login user
    const result = await authService.login(email, password);

    return c.json(result);
  } catch (error) {
    getLogger().error({ error }, 'Login failed');
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Login failed',
        },
      },
      401,
    );
  }
});

// Mount auth router
app.route('/auth', authRouter);
```

### 2. Registration Endpoint

Add a registration endpoint to dome-api:

```typescript
authRouter.post('/register', async (c: Context<{ Bindings: Bindings }>) => {
  try {
    const { email, password, name } = await c.req.json();

    // Create auth service client
    const authServiceUrl = 'https://auth.dome.example.com'; // Replace with actual URL
    const authService = new AuthServiceBinding(authServiceUrl);

    // Register user
    const result = await authService.register(email, password, name);

    return c.json(result);
  } catch (error) {
    getLogger().error({ error }, 'Registration failed');
    return c.json(
      {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Registration failed',
        },
      },
      400,
    );
  }
});
```

## Testing Authentication

1. Start both the auth service and dome-api:

```bash
cd services/auth
pnpm run dev

# In another terminal
cd services/dome-api
pnpm run dev
```

2. Register a user:

```bash
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123","name":"Test User"}'
```

3. Login to get a token:

```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

4. Use the token for authenticated requests:

```bash
curl -X GET http://localhost:8787/notes \
  -H "Authorization: Bearer <token>"
```

## Security Considerations

1. **Token Storage**: The client application should store tokens securely, preferably in HttpOnly cookies.

2. **HTTPS**: Always use HTTPS in production to protect tokens in transit.

3. **Token Expiration**: Tokens expire after 24 hours. Implement token refresh if needed.

4. **Rate Limiting**: Consider adding rate limiting to authentication endpoints to prevent brute force attacks.

5. **Password Policy**: Enforce strong password requirements.

## Next Steps

1. Implement token refresh functionality
2. Add passwordless authentication options
3. Implement multi-factor authentication
4. Add user profile management
