# BaseWorker

> **Version:** 1.0.0
> **Package:** `@dome/common`
> **Stack:** Cloudflare Workers · TypeScript 5

## 1. Overview

`BaseWorker` is a lightweight wrapper around Cloudflare's `WorkerEntrypoint` that
provides a consistent foundation for Dome services. It wires up logging and
metrics and exposes helper utilities that make it easier to build well-behaved
workers.

## 2. Constructor

```ts
new BaseWorker(ctx, env, buildServices, options?)
```

- `ctx: ExecutionContext` – the worker execution context
- `env: Env` – typed environment bindings for the worker
- `buildServices(env): Services` – a factory that creates service bindings. It is
  only invoked when `services` is first accessed.
- `options.serviceName?: string` – if provided, enables scoped logging and metric
  collection for the service

When a `serviceName` is supplied the worker automatically:

1. Creates a `metrics` collector via `createServiceMetrics(serviceName)`
2. Uses a child `logger` scoped with `{ service: serviceName }`
3. Sets up `wrap` using `createServiceWrapper(serviceName)` for standardized
   context and error handling

## 3. Services Getter

```ts
protected get services(): Services
```

Accessing `services` lazily constructs the bindings by calling `buildServices`
with `env` on first use and caches the result for subsequent calls.

## 4. Metrics

The optional `metrics` property implements the `ServiceMetrics` interface and is
initialized when a `serviceName` is provided. It exposes helpers to track
`counter`, `gauge`, and `timing` metrics, start timers, and record operation
success.

```ts
this.metrics?.counter('jobs_processed')
const timer = this.metrics?.startTimer('process')
// ...work...
timer?.stop()
```

## 5. Helper Properties

- `logger` – a Pino logger scoped to the service name
- `wrap(meta, fn)` – run a function with context propagation, logging and error
  conversion
- `trackedFetch` – wrapper around `fetch` that logs external calls

## 6. Example

```ts
class MyWorker extends BaseWorker<Env, Services> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env, buildServices, { serviceName: 'my-worker' })
  }

  async handleRequest() {
    return this.wrap({ operation: 'handle_request' }, async () => {
      const res = await this.trackedFetch('https://api.example.com')
      this.metrics?.counter('external_calls')
      return res
    })
  }
}
```
