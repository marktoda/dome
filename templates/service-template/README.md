# Dome Service Template

This template provides a standardized structure for creating new services in the Dome monorepo, following established patterns and best practices.

## Usage

1. Copy this template directory to `services/your-service-name/`
2. Replace all instances of `{{SERVICE_NAME}}` with your actual service name
3. Replace all instances of `{{SERVICE_DESCRIPTION}}` with your service description
4. Update the package.json with appropriate dependencies
5. Implement your service logic following the established patterns

## Generated Structure

```
services/your-service-name/
├── README.md                    # Service documentation
├── package.json                 # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── vitest.config.ts            # Test configuration
├── wrangler.toml               # Cloudflare Workers configuration
├── worker-configuration.d.ts    # Worker type definitions
├── src/
│   ├── index.ts                # Main entry point
│   ├── client/                 # Client SDK
│   │   ├── client.ts
│   │   ├── index.ts
│   │   └── types.ts
│   ├── controllers/            # HTTP controllers
│   │   └── index.ts
│   ├── services/               # Business logic
│   │   └── index.ts
│   ├── types.ts               # Type definitions
│   └── utils/                 # Utilities
│       ├── errors.ts          # Error handling
│       └── wrap.ts            # Request wrapping
└── tests/                     # Test files
    ├── setup.ts              # Test setup
    └── dummy.test.ts         # Example test
```

## Key Patterns

### Error Handling
- Use `@dome/common/errors` for standardized error handling
- Create service-specific errors with `createErrorFactory`
- Use `toDomeError` for error conversion

### Logging
- Import directly from `@dome/common` 
- Use service-specific logger: `getLogger().child({ service: 'your-service' })`
- Use `createServiceMetrics` for metrics collection

### Testing
- Use Vitest with TypeScript setup files
- Follow comprehensive testing patterns from ai-processor and constellation
- Mock external dependencies consistently

### Client SDK
- Provide typed client for service consumption
- Export from `client/index.ts`
- Include proper TypeScript types

## Dependencies

Standard dependencies included:
- **@dome/common**: Shared utilities, logging, error handling
- **hono**: Web framework (v4.0.0+)
- **zod**: Schema validation (v3.24.3)
- **vitest**: Testing framework
- **wrangler**: Cloudflare Workers CLI (v4.10.0+)

## Development Workflow

1. **Setup**: `pnpm install`
2. **Development**: `pnpm dev`
3. **Testing**: `pnpm test`
4. **Building**: `pnpm build`
5. **Deployment**: `pnpm deploy`

## Configuration

- Environment variables in `wrangler.toml`
- TypeScript configuration inherits from root
- Vitest configuration uses shared base config
- Worker bindings defined in `worker-configuration.d.ts`

## Best Practices

1. **Follow established patterns** from existing services
2. **Use shared utilities** from `@dome/common`
3. **Write comprehensive tests** for all business logic
4. **Document public APIs** with JSDoc
5. **Handle errors consistently** with standardized error types
6. **Use structured logging** for observability
7. **Type everything** with TypeScript
8. **Follow security best practices**

## Integration

Services should integrate with:
- **Auth service** for authentication
- **Silo service** for data storage
- **Constellation service** for embeddings
- **Tsunami service** for content ingestion

## Maintenance

- Keep dependencies up to date with other services
- Follow semver for breaking changes
- Update documentation when adding features
- Maintain test coverage above 80%