# Queue Queue 2.0 – Subclass-based Wrapper Pattern

**Status:** Draft — 2025-05-19  
**Author:** AI assistant  

---

## 1  Motivation

Developers still juggle raw Cloudflare Queue bindings, sprinkling `JSON.stringify` / validation everywhere.  
A simpler, *per-queue* wrapper pattern lets teams declare the shape of their messages once and forget about boiler-plate.

Key ideas:

* **One class per queue** → discoverable and type-safe (`ContentQueue`, `IngestQueue`, …).
* **AbstractQueue<T, S>** in `@dome/common` provides the heavy lifting; subclasses configure a Zod schema and inherit all behaviour.
* Compile-time generics guarantee only valid payloads can be sent.

---

## 2  Base Abstraction

```ts
// packages/common/src/queue/AbstractQueue.ts
import { Queue } from '@cloudflare/workers-types';
import { z, ZodSchema } from 'zod';
import {
  serializeQueueMessage,
  parseMessageBatch,
  toRawMessageBatch,
  ParsedMessageBatch,
  RawMessageBatch,
} from './helpers';

export abstract class AbstractQueue<T, S extends ZodSchema<T>> {
  /** Subclass must provide a Zod schema */
  protected abstract readonly schema: S;
  /** Queue binding injected at runtime */
  constructor(protected readonly queue: Queue) {}

  // ---------- PRODUCER SIDE ----------

  async send(message: T): Promise<void> {
    const body = serializeQueueMessage(this.schema, message);
    await this.queue.send(body);
  }

  async sendBatch(messages: Iterable<T>): Promise<void> {
    for (const m of messages) await this.send(m);
  }

  // ---------- CONSUMER SIDE ----------

  static parseBatch<T, S extends ZodSchema<T>>(
    this: new (...args: any[]) => AbstractQueue<T, S> & { schema: S },
    batch: MessageBatch<unknown>
  ): ParsedMessageBatch<T> {
    const raw = toRawMessageBatch(batch);
    return parseMessageBatch(this.prototype.schema, raw as RawMessageBatch);
  }
}
```

Notes:

* **Schema is an `abstract readonly` field**; each subclass sets it via `static readonly schema = …` in its definition.
* `parseBatch` is a **static helper** so consumers don't need an instance/binding when just parsing.
* We purposely do *not* expose `parseMessage` — if you need per-message parsing just map over the batch.

---

## 3  Example – `ContentQueue`

```ts
// services/content/src/queues/ContentQueue.ts
import { z } from 'zod';
import { AbstractQueue } from '@dome/common/queue';

export const ContentMessageSchema = z.object({
  id: z.string().uuid(),
  type: z.literal('content'),
  title: z.string(),
  body: z.string(),
});
export type ContentMessage = z.infer<typeof ContentMessageSchema>;

export class ContentQueue extends AbstractQueue<ContentMessage, typeof ContentMessageSchema> {
  protected readonly schema = ContentMessageSchema;
}
```

### Producer Usage

```ts
// inside an API worker
const queue = new ContentQueue(env.CONTENT_QUEUE);
await queue.send({ id: uuid(), type: 'content', title: 'Hello', body: 'World' });
```

### Consumer Usage

```ts
export default <ExporterQueue<_>>() => {
  return {
    queue: 'CONTENT_QUEUE',
    async batch(batch, env, ctx) {
      const parsed = ContentQueue.parseBatch(batch);
      for (const { body } of parsed.messages) {
        await processContent(body);
      }
    },
  };
};
```

No manual JSON parsing, no validation boiler-plate—errors surface early with clear Zod messages.

---

## 4  Ergonomics & Extensibility

* **Metrics / Logging** – We can augment `AbstractQueue` later with hooks (`beforeSend`, `afterReceive`) that subclasses inherit automatically.
* **DLQ Support** – Add `protected dlq?: Queue` in the base and forward failures inside `send` / `parseBatch`.
* **Batch Parallelism** – Once Workers supports array sends, override `sendBatch` implementation globally.
* **Custom Serialisers** – If a queue ever requires binary, subclasses can override `serialize` / `deserialize` protected helpers.

---

## 5  Implementation Plan

1. **Phase 0** – Add `AbstractQueue` + helpers into `packages/common` with full unit tests (Vitest).  
   • Keep API minimal (send, sendBatch, parseBatch).  
   • Export barrel `packages/common/src/queue/index.ts`.
2. **Phase 1** – Introduce `ContentQueue` in one low-risk service and migrate producers/consumers.  
   • Monitor errors, validate ergonomics.
3. **Phase 2** – Roll out to remaining queues (`IngestQueue`, `TodoQueue`, …).  
   • Provide codemod or manual guide.
4. **Phase 3** – Deprecate old helper imports (`serializeQueueMessage`, etc.) outside `AbstractQueue`.

---

## 6  Open Questions

1. Should `parseBatch` swallow & DLQ invalid messages instead of throwing?  
2. How to surface metrics (class mixin vs external wrapper)?  
3. Do we need an *interface* instead of an abstract class for easier tree-shaking?  

Feedback welcome! 