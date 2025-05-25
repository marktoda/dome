# Service Template

This template provides a standardized structure for creating new services in the Dome monorepo.

## Structure

```
service-name/
├── src/
│   ├── client/              # Client SDK
│   │   ├── client.ts        # Main client implementation
│   │   ├── index.ts         # Exports
│   │   └── types.ts         # Client types
│   ├── controllers/         # Request handlers
│   ├── services/           # Business logic
│   ├── queues/             # Queue handlers (if needed)
│   ├── db/                 # Database schema (if needed)
│   ├── index.ts            # Worker entrypoint
│   └── types.ts            # Service types
├── tests/
│   ├── setup.ts            # Test setup (TypeScript)
│   └── *.test.ts           # Test files
├── package.json
├── vitest.config.ts
├── tsconfig.json
├── wrangler.toml
└── README.md
```

## Standards

### Error Handling
- Use `@dome/common/errors` exclusively
- Create service-specific error factory: `createErrorFactory('service-name')`
- Use `toDomeError` for error conversion

### Logging
- Import directly from `@dome/common`: `getLogger`, `logError`, `trackOperation`
- Create service-specific logger: `getLogger().child({ service: 'service-name' })`
- Use `createServiceMetrics('service-name')` for metrics

### Testing
- Use TypeScript setup files (`tests/setup.ts`)
- Mock Cloudflare Workers: `vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }))`
- Follow Vitest patterns from existing services

### Dependencies
- Use latest stable versions aligned with other services
- Hono v4.x for routing
- Zod v3.24.3+ for validation
- Wrangler v4.x for deployment

## Client SDK Pattern

Every service should provide a client SDK following this pattern:

```typescript
// src/client/client.ts
export class ServiceNameClient {
  constructor(private config: ClientConfig) {}
  
  async someMethod(): Promise<Result> {
    // Implementation
  }
}

// src/client/index.ts
export { ServiceNameClient } from './client';
export type { ClientConfig, Result } from './types';
```

## Development Workflow

1. Copy this template to `services/your-service-name/`
2. Update package.json with service name and dependencies
3. Update wrangler.toml with service configuration
4. Implement core functionality following established patterns
5. Add comprehensive tests
6. Update service documentation