# Dome Logging SDK – Design Spec **v0.1.0‑alpha**

> **Package Name:** `@dome/logging` > **Runtime:** Cloudflare Workers (HTTP, Cron, Queue)
> **Stack:** TypeScript 5 · Hono v4 · Pino v8

---

## 1  Overview

`@dome/logging` is a drop‑in SDK that gives every Dome Worker a **structured, request‑aware logger** with one line of setup and one global helper:

```ts
initLogging(app);
getLogger().info('hello');
```

---

## 2  Installation

```bash
pnpm add @dome/logging    # private registry / workspace
```

Consumer Worker **must** enable ALS:

```toml
# wrangler.toml
compatibility_date = "2025-04-17"
compatibility_flags = ["nodejs_als"]
```

---

## 3  Public API

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
```

---

## 4  Package Files (with full source)

### 4.1 `src/base.ts`

```ts
import pino from 'pino';

/**
 * Global base logger – heavy Pino internals are initialised once per isolate.
 */
export const baseLogger = pino({
  level: (globalThis as any).LOG_LEVEL ?? 'info',
  browser: {
    asObject: true,
    write: obj => console.log(obj), // Workers picks this up for Logpush
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type BaseLogger = typeof baseLogger;
```

### 4.2 `src/helper.ts`

```ts
import { getContext } from 'hono/context-storage';
import { baseLogger, BaseLogger } from './base';

/**
 * Returns the request‑scoped logger if inside ALS context,
 * otherwise returns the singleton base logger.
 */
export function getLogger(): BaseLogger {
  const ctx = getContext<BaseLogger | undefined>();
  return (ctx?.get('logger') as BaseLogger) ?? baseLogger;
}
```

### 4.3 `src/middleware.ts`

```ts
import { MiddlewareHandler } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { baseLogger } from './base';
import { nanoid } from 'nanoid';
import type { InitOptions } from './types';

export function buildLoggingMiddleware(opts: InitOptions = {}): MiddlewareHandler {
  const idFactory = opts.idFactory ?? (() => nanoid(12));
  const extra = opts.extraBindings ?? {};

  return async (c, next) => {
    const reqId = idFactory();
    const child = baseLogger.child({
      reqId,
      ip: c.req.header('CF-Connecting-IP'),
      colo: c.req.raw.cf?.colo,
      cfRay: c.req.raw.headers.get('cf-ray'),
      ...extra,
    });

    c.set('logger', child);
    await next();
  };
}

/**
 * Convenience to wire both contextStorage & logging in one call.
 */
export function initLogging(app: import('hono').Hono, opts?: InitOptions) {
  app.use(contextStorage());
  app.use('*', buildLoggingMiddleware(opts));
}
```

### 4.4 `src/runWithLogger.ts`

```ts
import { ExecutionContext } from '@cloudflare/workers-types';
import { baseLogger } from './base';
import { getContext } from 'hono/context-storage';

export async function runWithLogger<T>(
  meta: object,
  fn: () => Promise<T>,
  ctx?: ExecutionContext,
): Promise<T> {
  const child = baseLogger.child(meta);
  const storage = getContext();
  // If no ALS context yet, fall back to base run
  if (!storage) return await fn();

  return (
    (await ctx?.run(() => {
      storage.set('logger', child);
      return fn();
    })) ?? fn()
  );
}
```

### 4.5 `src/index.ts`

```ts
export * from './base';
export * from './helper';
export * from './middleware';
export * from './runWithLogger';
export type { InitOptions } from './types';
```

### 4.6 `src/types.ts`

```ts
import pino from 'pino';

export interface InitOptions {
  idFactory?: () => string;
  extraBindings?: Record<string, unknown>;
  level?: pino.LevelWithSilent;
  serializer?: pino.SerializerFn;
}
```

---

## 5  Consumer Examples

### 5.1 HTTP API Worker (`services/dome-api/src/index.ts`)

```ts
import { Hono } from 'hono';
import { initLogging, getLogger } from '@dome/logging';

const app = new Hono();
initLogging(app); // <‑‑ one‑liner

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

### 5.2 Queue Consumer Worker

```ts
import { runWithLogger, getLogger } from '@dome/logging';

export default <QueueHandler>{
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

### 5.3 Cron Worker

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

---

## 6  Test Setup (Jest)

```ts
import { initLogging, getLogger } from '@dome/logging';
import { Hono } from 'hono';
import { unstable_dev } from 'wrangler';

describe('logging', () => {
  it('attaches logger', async () => {
    const app = new Hono();
    initLogging(app);
    app.get('/ping', c => {
      getLogger().info('hit ping');
      return c.text('pong');
    });
    const worker = await unstable_dev({ name: 'test', modules: [{ text: app }], bindings: {} });
    const res = await worker.fetch('http://localhost/ping');
    expect(await res.text()).toBe('pong');
  });
});
```

---

## 7  Changelog Template

```md
### Added

- Initial release with `initLogging`, `getLogger`, `runWithLogger`.

### Fixed / Changed

- n/a
```

---

End of document.
