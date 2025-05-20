# Code Organization Style Guide

This document defines the standard code organization patterns for the Dome project. Following these standards ensures consistency across services and makes the codebase more maintainable.

## Directory Structure

All services should follow this standardized directory structure:

```
services/[service-name]/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── config.ts                # Service configuration
│   ├── types.ts                 # Type definitions
│   ├── controllers/             # Request controllers
│   ├── services/                # Handlers for external services
│   ├── models/                  # Data models and schemas
│   ├── utils/                   # Utility functions
├── tests/
│   ├── unit/                    # Unit tests
│   └── integration/             # Integration tests
├── wrangler.toml                # Cloudflare Worker configuration
├── wrangler-configuration.d.ts  # auto generated cloudflare types
└── package.json                 # Package configuration
```

### Optional Directories

Depending on the service's needs, these additional directories may be included:

```
services/[service-name]/
├── src/
│   ├── db/                      # Database schemas and queries
├── migrations/                  # Database migrations
└── monitoring/                  # Monitoring configuration
```

## File Naming Conventions

- Use `camelCase` for file names
- Use `.ts` extension for TypeScript files
- Use `.test.ts` extension for test files
- Use descriptive names that indicate the file's purpose

### Examples

- `userService.ts` - Service for user-related business logic
- `userRepository.ts` - Repository for user data access
- `validationUtils.ts` - Utility functions for validation

## Code Organization Within Files

### Import Ordering

Imports should be organized in the following order, with a blank line between each group:

1. Node.js built-in modules
2. External dependencies
3. Internal shared packages (e.g., `@dome/common`, `@dome/logging`)
4. Local imports from the same service

Example:

```typescript
// Node.js built-in modules
import { createReadStream } from 'fs';
import { join } from 'path';

// External dependencies
import { Hono } from 'hono';
import { z } from 'zod';

// Internal shared packages
import { BaseError } from '@dome/common';
import { getLogger } from '@dome/logging';

// Local imports
import { config } from '../config';
import { UserService } from '../services/userService';
```

### Class Structure

Classes should be organized in the following order:

1. Properties
2. Constructor
3. Public methods
4. Private methods
5. Static methods

Example:

```typescript
export class UserService extends WorkerEntrypoint<Env> {
  // Properties
  private readonly db: Database;
  private readonly logger: Logger;

  // Constructor
  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  // Public methods
  public async getUser(id: string): Promise<User> {
    // Implementation
  }

  public async createUser(data: UserCreateData): Promise<User> {
    // Implementation
  }

  // Private methods
  private validateUserData(data: UserCreateData): boolean {
    // Implementation
  }

  // Static methods
  static createDefaultUser(): User {
    // Implementation
  }
}
```

## Standard Patterns

### RPC Implementation

Services should use the WorkerEntrypoint pattern with RPC decorators:

```typescript
import { WorkerEntrypoint } from 'cloudflare:workers';
import { rpcService, rpcMethod } from '@dome/rpc';
import { z } from 'zod';

@rpcService({ name: 'users' })
export default class UserService extends WorkerEntrypoint<Env> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
  }

  @rpcMethod({
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ id: z.string(), name: z.string() }),
  })
  async getUser(input: { id: string }) {
    // Implementation
    return { id: input.id, name: 'John Doe' };
  }
}
```

RPC schemas should be defined in a separate file:

```typescript
// src/rpc/schemas.ts
import { z } from 'zod';

export const getUserSchema = z.object({
  id: z.string().uuid(),
});

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.number(),
});

export type GetUserInput = z.infer<typeof getUserSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
```

### Handler Implementation

Handlers should follow this pattern:

```typescript
export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const logger = getLogger();

  try {
    // Parse and validate input
    const data = await parseRequestData(request);

    // Call service layer
    const service = new SomeService(env);
    const result = await service.performAction(data);

    // Return response
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    // Log and handle errors
    logger.error({ error }, 'Error handling request');
    return handleError(error);
  }
}
```

### Database Access

Database access should be encapsulated in repository classes:

```typescript
import { BaseRepository } from '@dome/db';

export class UserRepository extends BaseRepository<User> {
  constructor(client) {
    super(client, { name: 'users' });
  }

  async findById(id: string): Promise<User | null> {
    return this.executeQuery('findById', async () => {
      const result = await this.client.execute<User>('SELECT * FROM users WHERE id = ? LIMIT 1', [
        id,
      ]);

      return result.results[0] || null;
    });
  }

  // Other database operations...
}
```

### Queue Processing

Queue processing should follow the `AbstractQueue` pattern using typed queue
wrappers:

```typescript
import { ExampleQueue } from './queues/ExampleQueue';
import type { ExampleMessage } from './schemas';

export async function enqueueExample(env: Env, msg: ExampleMessage) {
  const queue = new ExampleQueue(env.EXAMPLE_QUEUE);
  await queue.send(msg);
}

export async function processQueueBatch(batch: MessageBatch<unknown>, env: Env) {
  const parsed = ExampleQueue.parseBatch(batch);

  for (const { body } of parsed.messages) {
    const service = new SomeService(env);
    await service.processData(body);
  }
}
```

### Migration Note

Replace any manual `JSON.parse` of queue messages with typed queue wrappers based on `AbstractQueue`.
Use `.send()` when enqueuing and `.parseBatch()` when consuming to ensure validation.

## Error Handling

- Use the `@dome/errors` package for standard error types
- Always log errors with context
- Return appropriate HTTP status codes for API errors
- Include helpful error messages in responses

Example:

```typescript
import { NotFoundError, ValidationError } from '@dome/errors';
import { getLogger } from '@dome/logging';

export async function getUser(id: string): Promise<User> {
  const logger = getLogger();

  try {
    if (!isValidId(id)) {
      throw new ValidationError('Invalid user ID format');
    }

    const user = await userRepository.findById(id);

    if (!user) {
      throw new NotFoundError(`User with ID ${id} not found`);
    }

    return user;
  } catch (error) {
    logger.error({ error, userId: id }, 'Error getting user');
    throw error;
  }
}
```

## Logging and Metrics

- Use the `@dome/logging` package for all logging
- Use the `@dome/metrics` package for all metrics
- Create child loggers with context for specific operations
- Use structured logging with context objects
- Add metrics for important operations

Example:

```typescript
import { getLogger } from '@dome/logging';
import { createMetrics } from '@dome/metrics';

const logger = getLogger();
const metrics = createMetrics('my-service');

export async function processData(data: ProcessData): Promise<Result> {
  const operationLogger = logger.child({
    operation: 'processData',
    dataId: data.id,
  });

  const timer = metrics.startTimer('data_processing');

  try {
    operationLogger.info('Starting data processing');

    // Process data
    const result = await actuallyProcessData(data);

    operationLogger.info({ resultSize: result.size }, 'Data processing completed');

    timer.stop({ success: 'true' });
    metrics.counter('data_processed', 1, { type: data.type });

    return result;
  } catch (error) {
    operationLogger.error({ error }, 'Error processing data');
    timer.stop({ success: 'false' });
    metrics.counter('data_processing_error', 1, { type: data.type });
    throw error;
  }
}
```

## Testing

- Write unit tests for individual functions and classes
- Write integration tests for API endpoints and workflows
- Use mocks for external dependencies
- Follow the AAA pattern (Arrange, Act, Assert)

Example:

```typescript
describe('UserService', () => {
  // Arrange
  const mockDb = createMockDatabase();
  const userService = new UserService(mockDb);

  beforeEach(() => {
    // Setup mocks
    mockDb.findById.mockReset();
  });

  it('should return user when found', async () => {
    // Arrange
    const mockUser = { id: '123', name: 'Test User' };
    mockDb.findById.mockResolvedValue(mockUser);

    // Act
    const result = await userService.getUser('123');

    // Assert
    expect(result).toEqual(mockUser);
    expect(mockDb.findById).toHaveBeenCalledWith('123');
  });

  it('should throw NotFoundError when user not found', async () => {
    // Arrange
    mockDb.findById.mockResolvedValue(null);

    // Act & Assert
    await expect(userService.getUser('123')).rejects.toThrow(NotFoundError);
  });
});
```
