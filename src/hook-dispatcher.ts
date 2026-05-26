import PQueue from "p-queue";
import type { HookContext, HookEvent } from "./hook-context";
import type { HookRegistry, RegisteredHook } from "./hook-registry";
import type { Dispatcher } from "./dispatcher";

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

/**
 * Per-event context factory. Built-in (`source: 'sdk'`) hooks receive
 * `dispatcher` in their HookContext (privileged write access to index.md /
 * log.md); plugin and vault-local hooks see `dispatcher: undefined`.
 * The split is the structural enforcement of HOOKS_CANNOT_BYPASS_TOOLS.
 */
export interface DispatcherCtxFactory {
  baseCtx: Omit<HookContext, "dispatcher">;
  dispatcher: Dispatcher;
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

  async dispatchEvents(events: ReadonlyArray<HookEvent>, ctxFactory: DispatcherCtxFactory): Promise<void> {
    await this.dispatchEventsWithCausation(events, ctxFactory, []);
  }

  async dispatchEventsWithCausation(
    events: ReadonlyArray<HookEvent>,
    ctxFactory: DispatcherCtxFactory,
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
        await this.invoke(h, event, ctxFactory);
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
        this.queue.add(() => this.invoke(h, event, ctxFactory));
      }
    }
  }

  private wouldCycle(hook: RegisteredHook, event: HookEvent, causation: CausationLink[]): boolean {
    const target = (event.path as string | undefined) ?? "";
    return causation.some(link => link.handlerId === hook.id && link.targetPath === target);
  }

  private async invoke(
    hook: RegisteredHook,
    event: HookEvent,
    ctxFactory: DispatcherCtxFactory
  ): Promise<void> {
    // HOOKS_CANNOT_BYPASS_TOOLS — built-in (sdk) hooks alone get the
    // privileged dispatcher; plugin and vault-local hooks see undefined.
    const ctx: HookContext = hook.source === "sdk"
      ? { ...ctxFactory.baseCtx, dispatcher: ctxFactory.dispatcher }
      : { ...ctxFactory.baseCtx };
    try {
      await hook.handler(event, ctx);
      this.registry.recordSuccess(hook.id);
    } catch {
      this.registry.recordFailure(hook.id);
      // The failure is recorded; lifecycle event emission is the dispatcher consumer's job.
    }
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
  }
}
