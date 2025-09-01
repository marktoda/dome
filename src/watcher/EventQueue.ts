import { FileEvent } from './types.js';

export class EventQueue {
  private queue: FileEvent[] = [];
  private processing = false;
  private idleCallbacks: Array<() => void> = [];

  add(event: FileEvent): void {
    this.queue.push(event);
  }

  pull(): FileEvent | undefined {
    return this.queue.shift();
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  size(): number {
    return this.queue.length;
  }

  setProcessing(value: boolean): void {
    this.processing = value;
    if (!this.processing && this.isEmpty()) {
      this.notifyIdle();
    }
  }

  onIdle(): Promise<void> {
    if (!this.processing && this.isEmpty()) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleCallbacks.push(resolve));
  }

  private notifyIdle(): void {
    const callbacks = this.idleCallbacks.splice(0);
    callbacks.forEach(cb => cb());
  }
}