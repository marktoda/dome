/**
 * A keyed, per-file serial queue with coalescing. Ensures only one task per key
 * runs at a time; bursty enqueues coalesce to a single final payload.
 */
export class KeyedQueue<K, P> {
  private pending = new Map<K, P>();
  private running = new Set<K>();
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly worker: (key: K, payload: P) => Promise<void>,
    private readonly coalesce: (prev: P, next: P) => P | null
  ) {}

  add(key: K, payload: P): void {
    const existing = this.pending.get(key);
    if (existing === undefined) {
      this.pending.set(key, payload);
    } else {
      const merged = this.coalesce(existing, payload);
      if (merged === null) {
        this.pending.delete(key);
      } else {
        this.pending.set(key, merged);
      }
    }

    if (!this.running.has(key)) {
      this.running.add(key);
      void this.runLoop(key);
    }
  }

  private async runLoop(key: K): Promise<void> {
    try {
      while (true) {
        const payload = this.pending.get(key);
        if (payload === undefined) break;
        this.pending.delete(key);
        await this.worker(key, payload);
      }
    } finally {
      this.running.delete(key);
      if (this.pending.size === 0 && this.running.size === 0) {
        this.idleResolvers.splice(0).forEach(r => r());
      }
    }
  }

  /**
   * Resolves when there are no more pending or running tasks.
   */
  onIdle(): Promise<void> {
    if (this.pending.size === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise<void>(resolve => this.idleResolvers.push(resolve));
  }
}