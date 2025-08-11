import { RelPath, toAbs } from '../utils/path-utils.js';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import { config } from './config.js';
import { noteEvents } from './events.js';
import {
  runBeforeSaveHooks,
  runAfterSaveHooks,
  NoteSaveContext,
} from './hooks/note-hooks.js';

export interface RawNote {
  path: NoteId;
  raw: string;
  fullPath: string;
}

export interface WriteResult {
  path: NoteId; // relative
  title: string;
  action: 'created' | 'updated';
  contentLength: number;
  fullPath: string; // absolute
}

export interface RemoveResult {
  path: NoteId;
  success: boolean;
  message: string;
}

/**
 * Alias for readability – a note identifier is simply the vault-relative path.
 */
export type NoteId = RelPath;

export interface FileWriteResult {
  path: NoteId;
  fullPath: string;
  existedBefore: boolean;
  bytesWritten: number;
}

export interface NoteStore {
  /** Retrieve and parse a note, or null if it doesn't exist */
  get(id: NoteId): Promise<RawNote | null>;

  /** Overwrite the note with raw markdown */
  store(id: NoteId, raw: string): Promise<FileWriteResult>;

  /** Quick existence check without reading the file */
  exists(id: NoteId): Promise<boolean>;

  /** List all notes */
  /** List all note files in the vault (no parsing) */
  list(): Promise<{ path: NoteId; fullPath: string }[]>;

  /** Delete a note */
  remove(id: NoteId): Promise<RemoveResult>;

  /** Rename a note to a new relative path */
  rename(from: NoteId, to: NoteId): Promise<{
    from: NoteId;
    to: NoteId;
    success: boolean;
    message: string;
  }>;
}

class FileSystemNoteStore implements NoteStore {
  /* ------------------------------------------------------------------ Helpers */
  private async prepareNoteFolder(relPath: RelPath): Promise<string> {
    const abs = toAbs(relPath);
    const filePath = path.extname(abs) ? abs : `${abs}.md`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  /* ------------------------------------------------------------------ API */

  async get(id: NoteId): Promise<RawNote | null> {
    const fullPath = toAbs(id);
    try {
      await fs.access(fullPath);
      const raw = await fs.readFile(fullPath, 'utf8');
      return { path: id, raw, fullPath };
    } catch {
      return null;
    }
  }

  async store(id: NoteId, rawContent: string): Promise<FileWriteResult> {
    // -------------------------------
    // Run before-save hooks (allows mutation of `currentRaw`)
    // -------------------------------
    const ctx: NoteSaveContext = {
      relPath: id,
      currentRaw: rawContent,
      originalRaw: rawContent,
    };

    await runBeforeSaveHooks(ctx);

    // The hook may have modified the raw text
    const contentToWrite = ctx.currentRaw;

    const relPath = id;
    const fullPath = await this.prepareNoteFolder(relPath);

    const existedBefore = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);

    await fs.writeFile(fullPath, contentToWrite, 'utf8');
    noteEvents.emit('note:changed', relPath);

    // -------------------------------
    // Run after-save hooks (non-blocking heavy logic can enqueue workflows)
    // -------------------------------
    ctx.fullPath = fullPath;
    ctx.existedBefore = existedBefore;
    ctx.bytesWritten = contentToWrite.length;

    // Fire and await – hooks should be fast; any lengthy work should spawn async jobs
    await runAfterSaveHooks(ctx);

    return {
      path: relPath,
      fullPath,
      existedBefore,
      bytesWritten: contentToWrite.length,
    };
  }

  async exists(id: NoteId): Promise<boolean> {
    try {
      await fs.access(toAbs(id));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<{ path: NoteId; fullPath: string }[]> {
    const paths = await fg('**/*.md', {
      cwd: config.DOME_VAULT_PATH,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });
    return paths.map(p => ({ path: p as NoteId, fullPath: path.join(config.DOME_VAULT_PATH, p) }));
  }

  async remove(id: NoteId): Promise<RemoveResult> {
    const fullPath = toAbs(id);
    try {
      await fs.access(fullPath);
      await fs.unlink(fullPath);
      noteEvents.emit('note:deleted', id);
      return { path: id, success: true, message: `Successfully removed note: ${id}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { path: id, success: false, message: `Failed to remove note ${id}: ${message}` };
    }
  }

  async rename(from: NoteId, to: NoteId): Promise<{
    from: NoteId;
    to: NoteId;
    success: boolean;
    message: string;
  }> {
    const fromAbs = toAbs(from);
    const toAbsPath = toAbs(to);

    try {
      // Ensure source exists
      await fs.access(fromAbs);

      // Ensure destination folder exists
      await fs.mkdir(path.dirname(toAbsPath), { recursive: true });

      // Perform rename (will fail if destination exists)
      await fs.rename(fromAbs, toAbsPath);

      noteEvents.emit('note:changed', from);
      noteEvents.emit('note:changed', to);

      return {
        from,
        to,
        success: true,
        message: `Renamed ${from} → ${to}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        from,
        to,
        success: false,
        message: `Failed to rename ${from} → ${to}: ${msg}`,
      };
    }

    // Should never reach here, but TypeScript demands a return.
    /* c8 ignore next */
    return {
      from,
      to,
      success: false,
      message: 'Unknown error',
    };
  }
}

/**
 * Default store backed by the local file system vault.
 */
export const noteStore: NoteStore = new FileSystemNoteStore();
