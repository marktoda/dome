# Queue Wrappers for Cloudflare Workers Queues

This module provides a type-safe, Zod-centric abstraction for interacting with Cloudflare Workers Queues.

## Core Concept: Subclass for Each Queue Type

The core pattern is to define one subclass per queue type, with a specific Zod schema:

```ts
// queues/ContentQueue.ts
import { z } from 'zod';
import { AbstractQueue } from '@dome/common/queue';

// 1. Define your message schema with Zod
export const ContentMessageSchema = z.object({
  id: z.string().uuid(),
  type: z.literal('content'),
  title: z.string(),
  body: z.string(),
});

// 2. Create a type from the schema
export type ContentMessage = z.infer<typeof ContentMessageSchema>;

// 3. Create a queue wrapper subclass
export class ContentQueue extends AbstractQueue<typeof ContentMessageSchema> {
  static override schema = ContentMessageSchema;
}
```

## Sending Messages (Producer)

In your producer code:

```ts
// 1. Create a queue instance with binding from env
const contentQueue = new ContentQueue(env.CONTENT_QUEUE);

// 2. Send a type-checked message (will fail compilation if wrong shape)
await contentQueue.send({
  id: crypto.randomUUID(),
  type: 'content',
  title: 'Hello World',
  body: 'This is a content message',
});

// 3. Send multiple messages
await contentQueue.sendBatch([
  { id: id1, type: 'content', title: 'First', body: 'Message 1' },
  { id: id2, type: 'content', title: 'Second', body: 'Message 2' },
]);
```

## Receiving Messages (Consumer)

In your queue consumer:

```ts
// Queue consumer function
export default {
  async queue(batch, env, ctx) {
    // Use static method to parse & validate all messages (no instance needed)
    const messages = ContentQueue.parseBatch(batch);
    
    // Loop through typed messages
    for (const { body } of messages.messages) {
      console.log(`Processing content: ${body.title}`);
      await processContent(body);
    }
  }
};
```

## Benefits

1. **Type-safety** - Compile-time guarantee that messages match the schema
2. **Zero parsing boilerplate** - No manual JSON.parse or validation code
3. **Centralized schema** - Message structure defined once, used everywhere
4. **Self-documenting** - Each queue has a dedicated class with schema
5. **Error handling** - Clear validation errors with Zod

## Upcoming Features

- Dead-letter queue integration
- Metrics/logging hooks
- Throttling and batching controls 