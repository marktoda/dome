// Note hooks registry – lightweight and synchronous-friendly
// Provides a simple event-like API for code that wants to run logic
// immediately before or after a note is persisted to disk.
//
// Keeping this minimal avoids pulling Mastra’s workflow engine into
// hot paths; heavyweight async work can enqueue a workflow from an
// after-save hook instead.

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

type Hook = (ctx: NoteSaveContext) => void | Promise<void>;

const beforeSaveHooks: Hook[] = [];
const afterSaveHooks: Hook[] = [];

/** Register a function to run *before* the note is written to disk. */
export function registerBeforeSaveHook(hook: Hook): void {
  beforeSaveHooks.push(hook);
}

/** Register a function to run *after* the note was successfully written. */
export function registerAfterSaveHook(hook: Hook): void {
  afterSaveHooks.push(hook);
}

export async function runBeforeSaveHooks(ctx: NoteSaveContext): Promise<void> {
  for (const hook of beforeSaveHooks) {
    await hook(ctx);
  }
}

export async function runAfterSaveHooks(ctx: NoteSaveContext): Promise<void> {
  for (const hook of afterSaveHooks) {
    await hook(ctx);
  }
} 