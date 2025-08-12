import logger from '../../utils/logger.js';
import { performance } from 'node:perf_hooks';

// Note hooks registry – lightweight and synchronous-friendly
// Provides a simple event-like API for code that wants to run logic
// immediately before or after a note is persisted to disk.
//
// Keeping this minimal avoids pulling Mastra’s workflow engine into
// hot paths; heavyweight async work can enqueue a workflow from an
// after-save hook instead.

export enum HookSite {
  BeforeSave = 'BeforeSave',
  AfterSave = 'AfterSave',
}

export interface NoteSaveContext {
  /** Vault-relative path: e.g. `projects/foo.md` */
  relPath: string;
  /** The complete markdown as it currently stands (may be mutated by hooks). */
  currentRaw: string;
  /** Original raw markdown as received by the store (pre-hook mutations). */
  originalRaw: string;
  /** Absolute path (populated *after* the file is written). */
  fullPath?: string;
  /** Whether the file existed before this write (populated post-save). */
  existedBefore?: boolean;
  /** Number of bytes written (post-save). */
  bytesWritten?: number;
}

// Core function signature all hooks must implement
export type HookFn = (ctx: NoteSaveContext) => void | Promise<void>;

// First-class policies
export enum OnErrorPolicy { Propagate = 'propagate', Suppress = 'suppress' }

export interface HookOptions {
  /** Unique, stable id to avoid double registration during hot reload. Defaults to displayName. */
  id?: string;
  /** Higher runs earlier; default 0. */
  priority?: number;
  /** Suppress/propagate errors; default: Before=Propagate, After=Suppress */
  onError?: OnErrorPolicy;
  /** Max runtime; if exceeded, we treat as error. */
  timeoutMs?: number;
  /** Optional predicate to decide at runtime. */
  runIf?: (ctx: NoteSaveContext) => boolean | Promise<boolean>;
  /** Only run for matching paths (minimizes perf hit). */
  pathIncludeGlobs?: string[];
  pathExcludeGlobs?: string[];
  /** Quick toggle to disable without removing registration. Default true. */
  enabled?: boolean;
}

// Standard structure stored in registry (object form)
export interface RegisteredHook {
  fn: HookFn;
  displayName: string;
  description?: string;
  hookSite: HookSite;
  options?: HookOptions;
}

export interface BeforeSaveHook extends RegisteredHook {
  hookSite: HookSite.BeforeSave;
}
export interface AfterSaveHook extends RegisteredHook {
  hookSite: HookSite.AfterSave;
}

const beforeSaveHooks: BeforeSaveHook[] = [];
const afterSaveHooks: AfterSaveHook[] = [];
const seenBeforeIds = new Set<string>();
const seenAfterIds = new Set<string>();
const hookStats = new Map<string, HookStats>();

// -------------------------------------------------------------
// Helper – consistent log formatting for hook execution
// -------------------------------------------------------------

function phaseLabel(phase: 'BeforeSave' | 'AfterSave', hook: RegisteredHook): string {
  return `[🤖 ${phase}: ${hook.displayName}]`;
}

function getHookId(hook: RegisteredHook): string {
  return hook.options?.id ?? hook.displayName;
}

export interface HookStats {
  runs: number;
  errors: number;
  totalDurationMs: number;
  lastDurationMs: number;
  get avgDurationMs(): number;
}

function getOrInitStats(id: string): HookStats {
  const existing = hookStats.get(id);
  if (existing) return existing;
  const stats: HookStats = {
    runs: 0,
    errors: 0,
    totalDurationMs: 0,
    lastDurationMs: 0,
    get avgDurationMs() {
      return this.runs ? Math.round(this.totalDurationMs / this.runs) : 0;
    },
  };
  hookStats.set(id, stats);
  return stats;
}

function defaultOnError(site: HookSite): OnErrorPolicy {
  return site === HookSite.BeforeSave ? OnErrorPolicy.Propagate : OnErrorPolicy.Suppress;
}

function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// Minimal glob matcher supporting **, *, ? for POSIX-like paths
function globToRegExp(glob: string): RegExp {
  // Escape regex special chars, then replace globs
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, r => `\\${r}`)
    .replace(/\*\*/g, '::GLOBSTAR::') // temp placeholder
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::GLOBSTAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(path: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some(g => globToRegExp(g).test(path));
}

function shouldRunForPath(relPath: string, options?: HookOptions): boolean {
  if (!options) return true;
  const { pathIncludeGlobs, pathExcludeGlobs } = options;
  if (pathIncludeGlobs && pathIncludeGlobs.length > 0) {
    if (!matchesAnyGlob(relPath, pathIncludeGlobs)) return false;
  }
  if (pathExcludeGlobs && pathExcludeGlobs.length > 0) {
    if (matchesAnyGlob(relPath, pathExcludeGlobs)) return false;
  }
  return true;
}

async function executeHooks(
  site: HookSite,
  hooks: RegisteredHook[],
  ctx: NoteSaveContext
): Promise<void> {
  const sorted = [...hooks].sort((a, b) => {
    const pa = a.options?.priority ?? 0;
    const pb = b.options?.priority ?? 0;
    if (pb !== pa) return pb - pa; // higher first
    const ida = getHookId(a);
    const idb = getHookId(b);
    return ida.localeCompare(idb);
  });
  for (const hook of sorted) {
    if (hook.options?.enabled === false) continue;
    if (!shouldRunForPath(ctx.relPath, hook.options)) continue;
    if (hook.options?.runIf) {
      const ok = await hook.options.runIf(ctx);
      if (!ok) continue;
    }

    const phase = site === HookSite.BeforeSave ? 'BeforeSave' : 'AfterSave';
    const label = phaseLabel(phase as 'BeforeSave' | 'AfterSave', hook);
    const start = performance.now();
    logger.info(`${label} starting`);
    logger.debug(`[hooks] id='${getHookId(hook)}' site='${site}'`);

    const onError = hook.options?.onError ?? defaultOnError(site);
    try {
      await withTimeout(Promise.resolve(hook.fn(ctx)), hook.options?.timeoutMs);
      const duration = Math.round(performance.now() - start);
      logger.info(`${label} finished in ${duration} ms`);
      const stats = getOrInitStats(getHookId(hook));
      stats.runs += 1;
      stats.lastDurationMs = duration;
      stats.totalDurationMs += duration;
    } catch (err) {
      const duration = Math.round(performance.now() - start);
      const msg = `${label} failed in ${duration} ms: ${err instanceof Error ? err.message : 'unknown error'}`;
      const stats = getOrInitStats(getHookId(hook));
      stats.runs += 1;
      stats.errors += 1;
      stats.lastDurationMs = duration;
      stats.totalDurationMs += duration;
      if (onError === OnErrorPolicy.Suppress) {
        logger.warn(msg);
        continue;
      }
      logger.error(msg);
      throw err;
    }
  }
}

/** Register a function to run *before* the note is written to disk. */
export function registerBeforeSaveHook(hook: BeforeSaveHook): void {
  const id = getHookId(hook);
  if (seenBeforeIds.has(id)) {
    logger.debug(`[hooks] Skipping duplicate before-save hook registration for id='${id}'`);
    return;
  }
  seenBeforeIds.add(id);
  beforeSaveHooks.push(hook);
}

/** Register a function to run *after* the note was successfully written. */
export function registerAfterSaveHook(hook: AfterSaveHook): void {
  const id = getHookId(hook);
  if (seenAfterIds.has(id)) {
    logger.debug(`[hooks] Skipping duplicate after-save hook registration for id='${id}'`);
    return;
  }
  seenAfterIds.add(id);
  afterSaveHooks.push(hook);
}

export async function runBeforeSaveHooks(ctx: NoteSaveContext): Promise<void> {
  await executeHooks(HookSite.BeforeSave, beforeSaveHooks, ctx);
}

export async function runAfterSaveHooks(ctx: NoteSaveContext): Promise<void> {
  await executeHooks(HookSite.AfterSave, afterSaveHooks, ctx);
}

/* ------------------------------------------------------------------
 * Convenient helpers for hook definition & auto-registration
 * ----------------------------------------------------------------*/

export function beforeSaveHook(
  name: string,
  fn: HookFn,
  description?: string,
  options?: HookOptions
): BeforeSaveHook {
  return { fn, displayName: name, description, hookSite: HookSite.BeforeSave, options };
}

export function afterSaveHook(
  name: string,
  fn: HookFn,
  description?: string,
  options?: HookOptions
): AfterSaveHook {
  return { fn, displayName: name, description, hookSite: HookSite.AfterSave, options };
}

// -------------------------------------------------------------
// Introspection and management utilities (useful for tests/hot-reload)
// -------------------------------------------------------------

export function listHooks(site?: HookSite): RegisteredHook[] {
  if (!site) return [...beforeSaveHooks, ...afterSaveHooks];
  return site === HookSite.BeforeSave ? [...beforeSaveHooks] : [...afterSaveHooks];
}

export function clearHooks(site?: HookSite): void {
  if (!site || site === HookSite.BeforeSave) {
    beforeSaveHooks.length = 0;
    seenBeforeIds.clear();
  }
  if (!site || site === HookSite.AfterSave) {
    afterSaveHooks.length = 0;
    seenAfterIds.clear();
  }
  if (!site) hookStats.clear();
}

export function unregisterHookById(site: HookSite, id: string): boolean {
  if (site === HookSite.BeforeSave) {
    const idx = beforeSaveHooks.findIndex(h => getHookId(h) === id);
    if (idx >= 0) {
      beforeSaveHooks.splice(idx, 1);
      seenBeforeIds.delete(id);
      return true;
    }
    return false;
  } else {
    const idx = afterSaveHooks.findIndex(h => getHookId(h) === id);
    if (idx >= 0) {
      afterSaveHooks.splice(idx, 1);
      seenAfterIds.delete(id);
      return true;
    }
    return false;
  }
}

export function getHookById(site: HookSite, id: string): RegisteredHook | undefined {
  return (site === HookSite.BeforeSave ? beforeSaveHooks : afterSaveHooks).find(
    h => getHookId(h) === id
  );
}

export function registerHooks(...hooks: Array<BeforeSaveHook | AfterSaveHook>): void {
  for (const h of hooks) {
    if (h.hookSite === HookSite.BeforeSave) registerBeforeSaveHook(h);
    else registerAfterSaveHook(h);
  }
}

export function getAllHookStats(): Record<string, HookStats> {
  const obj: Record<string, HookStats> = {};
  for (const [id, stats] of hookStats) obj[id] = stats;
  return obj;
}

export function getHookStatsById(id: string): HookStats | undefined {
  return hookStats.get(id);
}
