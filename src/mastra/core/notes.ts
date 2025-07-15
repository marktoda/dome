/**
 * Core notes management module for the Dome vault system.
 * Handles reading, writing, listing, and removing markdown notes.
 */

import * as path from 'path';
import { config } from './config.js';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { RelPath, toAbs, toRel } from '../utils/path-utils.js';
import { noteStore, NoteId } from './note-store.js';

/**
 * Metadata for a note without its content
 */
export interface NoteMeta {
  /** Note title (from frontmatter, first heading, or filename) */
  title: string;
  /** ISO date string when note was created */
  date: string;
  /** Array of tags from frontmatter */
  tags: string[];
  /** Relative path from vault root */
  path: NoteId;
  /** Source of the note (cli = created by dome, external = created outside) */
  source: "cli" | "external";
}

/**
 * Complete note with metadata and content
 */
export interface Note extends NoteMeta {
  /** Markdown content without frontmatter */
  body: string;
  /** raw text of the note */
  raw: string;
  /** Absolute filesystem path */
  fullPath: string;
}

/**
 * Result of a write operation
 */
export interface WriteResult {
  /** Relative path of the note */
  path: NoteId;
  /** Title of the note */
  title: string;
  /** Whether note was created or updated */
  action: "created" | "updated";
  /** Length of content written */
  contentLength: number;
  /** Absolute filesystem path */
  fullPath: string;
}

/**
 * Result of a remove operation
 */
export interface RemoveResult {
  /** Path of the removed note */
  path: NoteId;
  /** Whether removal was successful */
  success: boolean;
  /** Success or error message */
  message: string;
}

/**
 * List all notes in the vault, sorted by date (newest first)
 * @returns Array of note metadata
 */
export async function listNotes(): Promise<NoteMeta[]> {
  const entries = await noteStore.list();
  const metas: NoteMeta[] = [];

  for (const e of entries) {
    try {
      const raw = await fs.readFile(e.fullPath, 'utf8');
      const { data } = matter(raw);
      const meta = await deriveMeta(data, e.fullPath);
      metas.push(meta);
    } catch {
      // skip broken files
    }
  }

  return metas.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/**
 * Get a single note by its id
 * @param id - NoteId (vault-relative path, e.g., "meetings/standup.md")
 * @returns Note with content, or null if not found
 */
export async function getNote(id: NoteId): Promise<Note | null> {
  const rawNote = await noteStore.get(id);
  if (!rawNote) return null;

  const { data, content } = matter(rawNote.raw);
  const meta = await deriveMeta(data, rawNote.fullPath);
  return { ...meta, raw: rawNote.raw, body: content, fullPath: rawNote.fullPath };
}

async function deriveMeta(data: any, fullPath: string): Promise<NoteMeta> {
  const stat = await fs.stat(fullPath).catch(() => ({ birthtime: new Date() }));
  const fileName = path.basename(fullPath, path.extname(fullPath));
  // Compute the vault-relative path reliably so we don’t duplicate the vault prefix later
  const relativePath = path.relative(config.DOME_VAULT_PATH, fullPath);

  let title = data.title;
  if (!title) {
    const headingMatch = rawHeading(await fs.readFile(fullPath, 'utf8'));
    if (headingMatch) title = headingMatch;
  }
  return {
    title: title || fileName,
    date: data.date || stat.birthtime.toISOString(),
    tags: Array.isArray(data.tags) ? data.tags : [],
    path: relativePath as NoteId,
    source: data.source || 'external',
  };
}

function rawHeading(raw: string): string | undefined {
  const m = raw.match(/^#\s+(.*)$/m);
  return m ? m[1] : undefined;
}

/**
 * Write a note (create new or append to existing)
 * @param path - Relative path where to write the note
 * @param content - Markdown content to write
 * @param title - Optional title for new notes
 * @param tags - Optional tags for new notes
 * @returns Write operation result
 */
export async function writeNote(
  notePath: NoteId,
  content: string,
  title?: string,
  tags: string[] = []
): Promise<WriteResult> {
  const relPath: NoteId = toRel(notePath);

  // Does the note already exist?
  const existedBefore = await noteStore.exists(relPath);

  // Decide on a title
  const noteTitle = title ?? path.basename(relPath, path.extname(relPath));

  // Build the file content with updated front-matter
  let fileContent: string;

  if (existedBefore) {
    // Load existing raw to merge front-matter (if any)
    const existing = await noteStore.get(relPath);
    const existingFront = existing ? matter(existing.raw).data ?? {} : {};

    const updatedFront: Record<string, unknown> = {
      ...existingFront,
      modified: new Date().toISOString(),
    };

    if (tags.length) updatedFront.tags = tags;
    if (title) {
      updatedFront.title = noteTitle;
    } else if (!updatedFront.title) {
      updatedFront.title = noteTitle;
    }

    fileContent = matter.stringify(content, updatedFront);
  } else {
    fileContent = matter.stringify(content, {
      title: noteTitle,
      date: new Date().toISOString(),
      tags,
      source: 'cli',
    });
  }

  const writeInfo = await noteStore.store(relPath, fileContent);

  return {
    path: relPath,
    title: noteTitle,
    action: writeInfo.existedBefore ? 'updated' : 'created',
    contentLength: content.length,
    fullPath: writeInfo.fullPath,
  };
}

/**
 * Remove a note from the vault
 * @param path - Relative path of note to remove
 * @returns Removal result with success status
 */
export function removeNote(id: NoteId): Promise<RemoveResult> {
  return noteStore.remove(id);
}
