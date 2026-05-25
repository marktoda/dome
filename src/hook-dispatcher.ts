import PQueue from "p-queue";
import type { HookContext, HookEvent } from "./hook-context";
import type { HookRegistry, RegisteredHook } from "./hook-registry";

export interface CausationLink {
  handlerId: string;
  targetPath: string;
}

export interface CycleInfo {
  chain: CausationLink[];
  depth: number;
  triggeringHandler: string;
}

export interface HookDispatcherOpts {
  maxCausationDepth?: number;
  asyncConcurrency?: number;
}

export class HookDispatcher {
  private queue: PQueue;
  private maxDepth: number;
  private cycleListener: ((info: CycleInfo) => void) | null = null;

  constructor(private registry: HookRegistry, opts: HookDispatcherOpts = {}) {
    this.maxDepth = opts.maxCausationDepth ?? 50;
    this.queue = new PQueue({ concurrency: opts.asyncConcurrency ?? 1 });
  }

  onCycleDetected(listener: (info: CycleInfo) => void): void {
    this.cycleListener = listener;
  }

  async dispatchEvents(events: ReadonlyArray<HookEvent>, ctx: HookContext): Promise<void> {
    await this.dispatchEventsWithCausation(events, ctx, []);
  }

  async dispatchEventsWithCausation(
    events: ReadonlyArray<HookEvent>,
    ctx: HookContext,
    causation: CausationLink[]
  ): Promise<void> {
    // Depth safety net.
    if (causation.length >= this.maxDepth) {
      this.cycleListener?.({
        chain: [...causation],
        depth: causation.length,
        triggeringHandler: causation[causation.length - 1]?.handlerId ?? "(unknown)",
      });
      return;
    }

    for (const event of events) {
      const matches = this.registry.matchesEvent(event.kind);
      const sync = matches.filter(h => !h.async);
      const asyn = matches.filter(h => h.async);
      // Sync hooks run inline in registration order.
      for (const h of sync) {
        if (this.wouldCycle(h, event, causation)) {
          this.cycleListener?.({
            chain: [...causation],
            depth: causation.length,
            triggeringHandler: h.id,
          });
          continue;
        }
        await this.invoke(h, event, ctx);
      }
      // Async hooks enqueue.
      for (const h of asyn) {
        if (this.wouldCycle(h, event, causation)) {
          this.cycleListener?.({
            chain: [...causation],
            depth: causation.length,
            triggeringHandler: h.id,
          });
          continue;
        }
        this.queue.add(() => this.invoke(h, event, ctx));
      }
    }
  }

  private wouldCycle(hook: RegisteredHook, event: HookEvent, causation: CausationLink[]): boolean {
    const target = (event.path as string | undefined) ?? "";
    return causation.some(link => link.handlerId === hook.id && link.targetPath === target);
  }

  private async invoke(hook: RegisteredHook, event: HookEvent, ctx: HookContext): Promise<void> {
    try {
      await hook.handler(event, ctx);
      this.registry.recordSuccess(hook.id);
    } catch (e) {
      this.registry.recordFailure(hook.id);
      // The failure is recorded; lifecycle event emission is the dispatcher consumer's job.
    }
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
  }
}
