import logger from '../../utils/logger.js';

// Note hooks registry – lightweight and synchronous-friendly
// Provides a simple event-like API for code that wants to run logic
// immediately before or after a note is persisted to disk.
//
// Keeping this minimal avoids pulling Mastra’s workflow engine into
// hot paths; heavyweight async work can enqueue a workflow from an
// after-save hook instead.

enum HookSite {
  BeforeSave = 'BeforeSave',
  AfterSave = 'AfterSave',
}

export interface NoteSaveContext {
  /** Vault-relative path: e.g. `projects/foo.md` */
  relPath: string;
  /** The complete markdown that will be written to disk.  */
  raw: string;
  /** Absolute path (populated *after* the file is written). */
  fullPath?: string;
  /** Whether the file existed before this write (populated post-save). */
  existedBefore?: boolean;
  /** Number of bytes written (post-save). */
  bytesWritten?: number;
}

// Core function signature all hooks must implement
export type HookFn = (ctx: NoteSaveContext) => void | Promise<void>;

// Standard structure stored in registry (object form)
export interface RegisteredHook {
  fn: HookFn;
  displayName: string;
  description?: string;
  hookSite: HookSite;
}

export interface BeforeSaveHook extends RegisteredHook {
  hookSite: HookSite.BeforeSave;
}
export interface AfterSaveHook extends RegisteredHook {
  hookSite: HookSite.AfterSave;
}

const beforeSaveHooks: BeforeSaveHook[] = [];
const afterSaveHooks: AfterSaveHook[] = [];

// -------------------------------------------------------------
// Helper – consistent log formatting for hook execution
// -------------------------------------------------------------

function phaseLabel(phase: 'BeforeSave' | 'AfterSave', hook: RegisteredHook): string {
  return `[🤖 ${phase}: ${hook.displayName}]`;
}

/** Register a function to run *before* the note is written to disk. */
export function registerBeforeSaveHook(hook: BeforeSaveHook): void {
  beforeSaveHooks.push(hook);
}

/** Register a function to run *after* the note was successfully written. */
export function registerAfterSaveHook(hook: AfterSaveHook): void {
  afterSaveHooks.push(hook);
}

export async function runBeforeSaveHooks(ctx: NoteSaveContext): Promise<void> {
  for (const hook of beforeSaveHooks) {
    const label = phaseLabel('BeforeSave', hook);
    const start = Date.now();
    logger.info(`${label} starting`);

    try {
      await hook.fn(ctx);
      const duration = Date.now() - start;
      logger.info(`${label} finished in ${duration} ms`);
    } catch (err) {
      logger.error(
        `${label} failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
      throw err; // propagate to caller – hooks are expected to block save on error
    }
  }
}

export async function runAfterSaveHooks(ctx: NoteSaveContext): Promise<void> {
  for (const hook of afterSaveHooks) {
    const label = phaseLabel('AfterSave', hook);
    const start = Date.now();
    logger.info(`${label} starting`);

    try {
      await hook.fn(ctx);
      const duration = Date.now() - start;
      logger.info(`${label} finished in ${duration} ms`);
    } catch (err) {
      logger.error(
        `${label} failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
      throw err;
    }
  }
}

/* ------------------------------------------------------------------
 * Convenient helpers for hook definition & auto-registration
 * ----------------------------------------------------------------*/

export function beforeSaveHook(
  name: string,
  fn: HookFn,
  description?: string
): BeforeSaveHook {
  return { fn, displayName: name, description, hookSite: HookSite.BeforeSave };
}

export function afterSaveHook(
  name: string,
  fn: HookFn,
  description?: string
): AfterSaveHook {
  return { fn, displayName: name, description, hookSite: HookSite.AfterSave };
}
