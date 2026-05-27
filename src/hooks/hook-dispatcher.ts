import PQueue from "p-queue";
import { AsyncLocalStorage } from "node:async_hooks";
import type { HookContext, HookEvent } from "./hook-context";
import type { HookRegistry, RegisteredHook } from "./hook-registry";
import type { PrivilegedWriter } from "../privileged-writer";

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
 * `privilegedWriter` in their HookContext (privileged write access to
 * index.md / log.md); plugin and vault-local hooks see
 * `privilegedWriter: undefined`. The split is the structural enforcement
 * of HOOKS_CANNOT_BYPASS_TOOLS + INDEX_AND_LOG_ARE_DISPATCHER_OWNED.
 */
export interface DispatcherCtxFactory {
  baseCtx: Omit<HookContext, "privilegedWriter">;
  privilegedWriter: PrivilegedWriter;
}

/**
 * Per-dispatch-chain causation storage. When a hook handler invokes a Tool
 * (via ctx.tools.X), the Tool's effects produce events that flow back into
 * dispatchEvents; without ambient causation tracking, that re-entry resets
 * the chain to [] and the depth-net never sees the depth. AsyncLocalStorage
 * carries the active chain across the await boundary into the wrap() closure
 * and into vault.dispatchEvents, so hook -> Tool -> projected event -> hook
 * re-entry sees the full causal lineage.
 */
const causationStore = new AsyncLocalStorage<CausationLink[]>();

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
    // Pick up any ambient causation chain — when a hook handler invokes a
    // Tool whose Effects re-enter dispatchEvents, we want this re-entry to
    // extend the existing chain, not reset to [].
    const ambient = causationStore.getStore() ?? [];
    await this.dispatchEventsWithCausation(events, ctxFactory, ambient);
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
        await this.invoke(h, event, ctxFactory, causation);
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
        // p-queue's add returns a promise we don't await here (fire-and-forget
        // until drainHooks). Capture the current causation snapshot so the
        // async invocation extends it rather than picking up some other
        // chain that happens to be ambient when the queued task runs.
        const queuedCausation = [...causation];
        this.queue.add(() => this.invoke(h, event, ctxFactory, queuedCausation));
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
    ctxFactory: DispatcherCtxFactory,
    causation: ReadonlyArray<CausationLink>,
  ): Promise<void> {
    // HOOKS_CANNOT_BYPASS_TOOLS — built-in (sdk) hooks alone get the
    // privileged writer; plugin and vault-local hooks see undefined.
    const ctx: HookContext = hook.source === "sdk"
      ? { ...ctxFactory.baseCtx, privilegedWriter: ctxFactory.privilegedWriter }
      : { ...ctxFactory.baseCtx };
    // Extend the causation chain with this handler's (id, target) link and
    // park it in AsyncLocalStorage so any Tool the handler invokes -> any
    // Effect those Tools emit -> any event projected from those Effects ->
    // any re-entry into dispatchEvents picks up THIS chain rather than
    // restarting from []. This is what makes the depth safety net and the
    // multi-hop cycle check reachable.
    const targetPath = (event.path as string | undefined) ?? "";
    const extended: CausationLink[] = [...causation, { handlerId: hook.id, targetPath }];
    try {
      await causationStore.run(extended, () => hook.handler(event, ctx));
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
