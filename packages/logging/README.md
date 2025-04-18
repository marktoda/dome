# @dome/logging

A structured, request-aware logger for Dome Workers with minimal setup.

## Installation

```bash
pnpm add @dome/logging    # private registry / workspace
```

Consumer Worker **must** enable ALS:

```toml
# wrangler.toml
compatibility_date = "2025-04-17"
compatibility_flags = ["nodejs_als"]
```

## Usage

### HTTP API Worker

```ts
import { Hono } from 'hono';
import { initLogging, getLogger } from '@dome/logging';

const app = new Hono();
initLogging(app); // <-- one-liner

app.get('/users/:id', async c => {
  getLogger().info({ params: c.req.param() }, 'fetch user');
  return c.json({ ok: true });
});

app.onError((err, c) => {
  getLogger().error({ err }, 'unhandled');
  return c.json({ error: 'internal' }, 500);
});

export default app;
```

### Queue Consumer Worker

```ts
import { runWithLogger, getLogger } from '@dome/logging';

export default {
  async queue(batch, env, ctx) {
    await runWithLogger(
      { trigger: 'queue', batch: batch.length },
      async () => {
        getLogger().info('processing batch');
        // ...process
      },
      ctx,
    );
  },
};
```

### Cron Worker

```ts
import { runWithLogger, getLogger } from '@dome/logging';

export default {
  async scheduled(event, env, ctx) {
    await runWithLogger(
      { trigger: 'cron', cron: event.cron },
      async () => {
        getLogger().debug('cron tick');
        // ...job work
      },
      ctx,
    );
  },
};
```

## API

```ts
function initLogging(app: Hono, options?: InitOptions): void;
function getLogger(): Logger;
function runWithLogger(meta: object, fn: () => Promise<unknown>): Promise<void>;
```

`InitOptions` interface:

```ts
interface InitOptions {
  idFactory?: () => string;
  extraBindings?: Record<string, unknown>;
  level?: pino.LevelWithSilent;
  serializer?: pino.SerializerFn;
}