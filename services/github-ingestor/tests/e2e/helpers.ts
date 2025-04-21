import { Miniflare } from 'miniflare';
import { ExtendedMiniflare, asMiniflareWithCron } from '../types';
import { vi } from 'vitest';

/**
 * Create a Miniflare instance for testing with proper service binding configuration
 */
export function createTestMiniflare(options: {
  bindings?: Record<string, string>;
  mockSiloFetch?: boolean;
}): ExtendedMiniflare {
  const { bindings = {}, mockSiloFetch = true } = options;

  // Create a mock for the SILO service if requested
  const siloService = mockSiloFetch ? { fetch: vi.fn() } : undefined;

  // Create the Miniflare instance with the correct configuration
  const mf = asMiniflareWithCron(
    new Miniflare({
      modules: true,
      scriptPath: 'dist/index.js',
      bindings: {
        VERSION: '1.0.0-test',
        ENVIRONMENT: 'test',
        LOG_LEVEL: 'debug',
        GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
        GITHUB_TOKEN: 'test-github-token',
        ...bindings,
      },
      d1Databases: [
        {
          binding: 'DB',
          database: ':memory:',
          migrationsPath: 'src/db/migrations',
        },
      ],
      queueConsumers: ['INGEST_QUEUE'],
      // Use string binding for service bindings to avoid validation errors
      serviceBindings: siloService ? { SILO: 'silo-service' } : {},
    } as any),
  );

  // If we're mocking the SILO service, attach the mock to the env
  if (mockSiloFetch) {
    mf.getBindings().then(env => {
      // @ts-ignore - We're adding the mock to the env
      env.SILO = siloService;
    });
  }

  return mf;
}
