/**
 * Context Manager for the Dome vault system.
 * Handles loading, merging, and applying folder-based contexts.
 */

import { join, dirname, resolve } from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { NoteId } from '../note-store.js';

const MAX_DEPTH = 10;

/**
 * Manages context configurations for the Dome vault
 */
export class ContextManager {
  /**
   * Load a context from a specific folder
   * @param folderPath - Absolute path to the folder
   * @returns Context configuration or null if not found
   */
  async loadContext(folderPath: string): Promise<string | null> {
    const contextPath = join(folderPath, '.dome');
    try {
      return await fs.readFile(contextPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Get merged context combining all parent contexts
   * @param notePath - Path to the note
   * @param maxDepth - Maximum levels to search up
   * @returns Merged context from all parents
   */
  async getContext(
    noteId: NoteId,
    maxDepth: number = 10
  ): Promise<string | null> {
    const contexts = await this.getAllParentContexts(noteId, maxDepth);
    if (!contexts) return null;

    // Reverse to put parent contexts first
    const reversedContexts = [...contexts].reverse();

    // Append all contexts together with level information
    return reversedContexts.map(ctx =>
      `# Context from level ${ctx.level} (${ctx.path})\n\n${ctx.content}`
    ).join('\n\n---\n\n');
  }

  /**
   * Get a full index of all contexts in the vault
   * @returns Formatted document with all contexts, their paths, and depths
   */
  async getIndex(): Promise<string | null> {
    const contextFiles = await this.listContextFiles();
    if (contextFiles.length === 0) return null;

    const contextData: Array<{
      path: string;
      depth: number;
      content: string;
    }> = [];

    // Process each context file
    for (const filePath of contextFiles) {
      const dirPath = dirname(filePath);
      const content = await this.loadContext(dirPath);
      if (content) {
        // Calculate depth relative to vault root
        const relativePath = dirPath.replace(config.DOME_VAULT_PATH, '').replace(/^\//, '') || '/';
        const depth = relativePath === '/' ? 0 : relativePath.split('/').length;

        contextData.push({
          path: dirPath,
          depth,
          content
        });
      }
    }

    // Sort by path to ensure consistent ordering
    contextData.sort((a, b) => a.path.localeCompare(b.path));

    // Format the index document
    const indexParts = [
      '# Dome Context Index',
      `Generated at: ${new Date().toISOString()}`,
      `Total contexts: ${contextData.length}`,
      '',
      '='.repeat(80),
      ''
    ];

    // Add each context with formatting
    for (const ctx of contextData) {
      const indent = '  '.repeat(ctx.depth);
      const relativePath = ctx.path.replace(config.DOME_VAULT_PATH, '') || '/';

      indexParts.push(
        `${indent}## Context at: ${relativePath}`,
        `${indent}Depth: ${ctx.depth}`,
        `${indent}Full path: ${ctx.path}`,
        '',
        `${indent}### Content:`,
        ctx.content.split('\n').map(line => `${indent}${line}`).join('\n'),
        '',
        '-'.repeat(80),
        ''
      );
    }

    return indexParts.join('\n');
  }

  /**
   * Create a new context in a folder
   * @param folderPath - Absolute path to the folder
   * @param context - Context configuration to save
   */
  async createContext(
    folderPath: string,
    context: string
  ): Promise<void> {
    const contextPath = join(folderPath, '.dome');
    await fs.writeFile(contextPath, context, 'utf-8');
  }

  /**
   * List all contexts in the vault
   * @returns Array of context paths and configurations
   */
  async listContexts(): Promise<Array<{
    path: string;
    context: string | null;
  }>> {
    const contextFiles = await this.listContextFiles();

    const contexts = await Promise.all(
      contextFiles.map(async (filePath) => ({
        path: dirname(filePath)
          .replace(config.DOME_VAULT_PATH, '')
          .replace(/^\//, '') || '/',
        context: await this.loadContext(dirname(filePath)),
      }))
    );

    return contexts.filter(c => c.context !== null);
  }

  /**
   * Get all parent contexts for a given note path
   * @param notePath - Path to the note file
   * @param maxDepth - Maximum levels to search up (defaults to MAX_DEPTH)
   * @returns Array of context strings with level information
   */
  private async getAllParentContexts(
    notePath: NoteId | string,
    maxDepth: number = MAX_DEPTH
  ): Promise<Array<{ content: string; level: number; path: string }> | null> {
    const contexts: Array<{ content: string; level: number; path: string }> = [];

    // Ensure we are working with an absolute path *inside* the vault. If callers
    // pass a vault-relative path (e.g. "projects/alpha.md"), prefix it with the
    // configured vault root so that subsequent directory traversals work as
    // expected even when the CLI is executed from arbitrary working
    // directories.
    const absoluteNotePath = notePath.startsWith('/')
      ? notePath
      : join(config.DOME_VAULT_PATH, notePath);

    let currentDir = dirname(resolve(absoluteNotePath));
    let depth = 0;

    // Collect all contexts from the note's folder up to the filesystem root or
    // until we reach the configured maximum depth.
    while (depth < maxDepth) {
      const context = await this.loadContext(currentDir);
      // Push the context entry even if the file is empty (""), but only skip
      // truly missing files (null). This allows users to create placeholder
      // context files that are intentionally empty.
      if (context !== null) {
        contexts.push({
          content: context,
          level: depth,
          path: currentDir,
        });
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break; // Reached root

      currentDir = parentDir;
      depth++;
    }

    return contexts.length > 0 ? contexts : null;
  }


  /**
   * Helper method to list all context files in the vault
   */
  private async listContextFiles(): Promise<string[]> {
    const files: string[] = [];

    const walkDir = async (dir: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.name === '.dome') {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore directories we can't read
      }
    };

    await walkDir(config.DOME_VAULT_PATH);
    return files;
  }
}
