import { als, baseLogger } from './runtime';
import type { Logger } from 'pino';

type Meta = Record<string, unknown> & { level?: string };

export async function withLogger<T>(meta: Meta, fn: (log: Logger) => Promise<T> | T): Promise<T> {
  const child = baseLogger.child(meta, { level: meta.level });

  // Wrap the user callback in a fresh ALS scope so any downstream
  // `getLogger()` can retrieve the same instance.
  return als.run(new Map([['logger', child]]), async () => fn(child));
}
