import type { HookHandler } from "./hook-context";
import { makeQuarantineStore, type QuarantineStore } from "./quarantine-store";

export type HookSource = "sdk" | "plugin" | "vault-local";

export interface RegisteredHook {
  id: string;
  pattern: string;            // dotted-path with wildcards; e.g., "document.written.wiki.*"
  handler: HookHandler;
  source: HookSource;
  async: boolean;             // default true; sync hooks run inline
  idempotent: boolean;        // default true; opt out makes reconciliation skip
}

const QUARANTINE_THRESHOLD = 3;

export interface HookRegistryOpts {
  /** Path to .dome/state/quarantined.json. When unset, no persistence. */
  persistPath?: string;
  /** Optional pre-loaded quarantine set (read from disk by openVault). */
  initialQuarantined?: ReadonlyArray<string>;
}

export class HookRegistry {
  private hooks: Map<string, RegisteredHook> = new Map();
  private failures: Map<string, number> = new Map();
  private quarantined: Set<string> = new Set();
  private order: string[] = []; // preserves insertion order across overrides
  private store: QuarantineStore | null = null;
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(opts: HookRegistryOpts = {}) {
    if (opts.persistPath !== undefined) {
      this.store = makeQuarantineStore(opts.persistPath);
    }
    if (opts.initialQuarantined !== undefined) {
      for (const id of opts.initialQuarantined) this.quarantined.add(id);
    }
  }

  register(hook: RegisteredHook): void {
    if (!this.hooks.has(hook.id)) {
      this.order.push(hook.id);
    }
    this.hooks.set(hook.id, hook);
  }

  list(): RegisteredHook[] {
    return this.order.map(id => this.hooks.get(id)!).filter(Boolean);
  }

  matchesEvent(eventKind: string): RegisteredHook[] {
    const results: RegisteredHook[] = [];
    for (const id of this.order) {
      const hook = this.hooks.get(id);
      if (!hook) continue;
      if (this.quarantined.has(hook.id)) continue;
      if (matchPattern(hook.pattern, eventKind)) {
        results.push(hook);
      }
    }
    return results;
  }

  recordFailure(id: string): void {
    const next = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, next);
    if (next >= QUARANTINE_THRESHOLD) {
      const wasNew = !this.quarantined.has(id);
      this.quarantined.add(id);
      if (wasNew) this.scheduleSave();
    }
  }

  recordSuccess(id: string): void {
    this.failures.delete(id);
  }

  isQuarantined(id: string): boolean {
    return this.quarantined.has(id);
  }

  resetQuarantines(): void {
    if (this.quarantined.size === 0 && this.failures.size === 0) return;
    this.quarantined.clear();
    this.failures.clear();
    this.scheduleSave();
  }

  /** Resolves when any in-flight persistence write has landed on disk. */
  flushPersist(): Promise<void> {
    return this.pendingPersist;
  }

  private scheduleSave(): void {
    const store = this.store;
    if (store === null) return;
    const ids = [...this.quarantined];
    this.pendingPersist = this.pendingPersist.then(() => store.save(ids)).catch(() => {});
  }
}

export function matchPattern(pattern: string, eventKind: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventKind) return true;
  if (!pattern.includes("*")) return false;
  const patternParts = pattern.split(".");
  const eventParts = eventKind.split(".");
  if (patternParts.length > eventParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const ep = eventParts[i]!;
    if (pp === "*") continue;
    if (pp !== ep) return false;
  }
  // pattern.length === eventParts.length OR the last pattern token is `*` matching the rest
  return patternParts.length === eventParts.length || patternParts[patternParts.length - 1] === "*";
}
