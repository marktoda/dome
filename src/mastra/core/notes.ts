/**
 * Core notes management module for the Dome vault system.
 * Handles reading, writing, listing, and removing markdown notes.
 */

import fg from "fast-glob";
import fs from "node:fs/promises";
import matter from "gray-matter";
import { join, basename, extname } from "node:path";
import { writeNoteWithContext } from "./context/notes-integration.js";
import { config } from './config.js';

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
  path: string;
  /** Source of the note (cli = created by dome, external = created outside) */
  source: "cli" | "external";
}

/**
 * Complete note with metadata and content
 */
export interface Note extends NoteMeta {
  /** Markdown content without frontmatter */
  body: string;
  /** Absolute filesystem path */
  fullPath: string;
}

/**
 * Result of a write operation
 */
export interface WriteResult {
  /** Relative path of the note */
  path: string;
  /** Title of the note */
  title: string;
  /** Whether note was created or appended to */
  action: "created" | "appended";
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
  path: string;
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
  try {
    const paths = await fg("**/*.md", {
      cwd: config.DOME_VAULT_PATH,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"]
    });

    const metas = await Promise.all(paths.map(parseMeta));
    return metas.sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  } catch (error) {
    console.error("Error listing notes:", error);
    return [];
  }
}

/**
 * Get a single note by its path
 * @param path - Relative path from vault root (e.g., "meetings/standup.md")
 * @returns Note with content, or null if not found
 */
export async function getNote(path: string): Promise<Note | null> {
  try {
    const fullPath = join(config.DOME_VAULT_PATH, path);
    await fs.access(fullPath);

    const raw = await fs.readFile(fullPath, "utf8");
    const { data, content } = matter(raw);
    const meta = await deriveMeta(data, fullPath);

    return {
      ...meta,
      body: content,
      fullPath
    };
  } catch {
    // File doesn't exist or can't be read
    return null;
  }
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
  path: string,
  content: string,
  title?: string,
  tags: string[] = []
): Promise<WriteResult> {
  // Delegate to context-aware writing system
  const result = await writeNoteWithContext({
    path,
    content,
    title,
    tags,
    respectContext: true
  });

  // Return standard result (without context-specific fields)
  return {
    path: result.path,
    title: result.title,
    action: result.action,
    contentLength: result.contentLength,
    fullPath: result.fullPath
  };
}

/**
 * Remove a note from the vault
 * @param path - Relative path of note to remove
 * @returns Removal result with success status
 */
export async function removeNote(path: string): Promise<RemoveResult> {
  try {
    const fullPath = join(config.DOME_VAULT_PATH, path);

    // Verify file exists
    await fs.access(fullPath);

    // Remove the file
    await fs.unlink(fullPath);

    return {
      path,
      success: true,
      message: `Successfully removed note: ${path}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      path,
      success: false,
      message: `Failed to remove note ${path}: ${message}`
    };
  }
}

/**
 * Parse metadata from a note file
 * @param relativePath - Path relative to vault root
 * @returns Note metadata
 */
async function parseMeta(relativePath: string): Promise<NoteMeta> {
  const fullPath = join(config.DOME_VAULT_PATH, relativePath);

  try {
    const raw = await fs.readFile(fullPath, "utf8");
    const { data } = matter(raw);
    return deriveMeta(data, fullPath);
  } catch (error) {
    // If can't read file, return minimal metadata
    console.error(`Error parsing meta for ${relativePath}:`, error);

    const stat = await fs.stat(fullPath).catch(() => ({
      birthtime: new Date()
    }));

    return {
      title: basename(fullPath, extname(fullPath)),
      date: stat.birthtime.toISOString(),
      tags: [],
      path: relativePath,
      source: "external"
    };
  }
}

/**
 * Derive complete metadata from frontmatter and file info
 * @param data - Parsed frontmatter data
 * @param fullPath - Absolute path to the file
 * @returns Complete note metadata
 */
async function deriveMeta(data: any, fullPath: string): Promise<NoteMeta> {
  const stat = await fs.stat(fullPath).catch(() => ({
    birthtime: new Date()
  }));

  const fileName = basename(fullPath, extname(fullPath));
  const relativePath = fullPath.replace(`${config.DOME_VAULT_PATH}/`, "");

  // Determine title: frontmatter > first heading > filename
  let title = data.title;

  if (!title) {
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const headingMatch = raw.match(/^#\s+(.*)$/m);
      if (headingMatch) {
        title = headingMatch[1];
      }
    } catch {
      // Ignore read errors
    }
  }

  return {
    title: title || fileName,
    date: data.date || stat.birthtime.toISOString(),
    tags: Array.isArray(data.tags) ? data.tags : [],
    path: relativePath,
    source: data.source || "external"
  };
}
