/**
 * Context-aware search integration
 */

import { ContextManager } from './manager.js';
import { searchSimilarNotes } from '../search-indexer.js';
import { openai } from "@ai-sdk/openai";
import { embed } from "ai";

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

export interface ContextSearchOptions {
  query: string;
  k?: number;
  contextPath?: string;
  includeInheritedContexts?: boolean;
}

export interface ContextSearchResult {
  notePath: string;
  score: number;
  excerpt: string;
  tags?: string[];
  context?: {
    name: string;
    path: string;
  };
}

/**
 * Search notes with context awareness
 */
export async function searchNotesWithContext(options: ContextSearchOptions): Promise<ContextSearchResult[]> {
  const { query, k = 6, contextPath, includeInheritedContexts = true } = options;
  
  // Generate embedding for the query
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: query,
  });
  
  // Search for similar vectors
  const results = await searchSimilarNotes(embedding, k * 2); // Get more results for filtering
  
  if (!Array.isArray(results)) {
    return [];
  }
  
  const manager = new ContextManager(vaultPath);
  const contextResults: ContextSearchResult[] = [];
  
  // If contextPath is specified, filter results to that context
  if (contextPath) {
    for (const result of results) {
      if (!result.metadata?.notePath) continue;
      
      const notePath = join(vaultPath, result.metadata.notePath);
      const noteContext = await manager.findContextForPath(notePath);
      
      if (!noteContext) continue;
      
      // Check if note belongs to the requested context
      const contextDir = dirname(noteContext.contextFilePath);
      const requestedContextDir = resolve(vaultPath, contextPath);
      
      const belongsToContext = includeInheritedContexts
        ? contextDir.startsWith(requestedContextDir) || requestedContextDir.startsWith(contextDir)
        : contextDir === requestedContextDir;
      
      if (belongsToContext) {
        contextResults.push({
          notePath: result.metadata.notePath,
          score: result.score || 0,
          excerpt: result.metadata.text || "",
          tags: Array.isArray(result.metadata.tags) ? result.metadata.tags : [],
          context: {
            name: noteContext.context.name,
            path: contextDir.replace(vaultPath, '').replace(/^\//, '') || '/',
          }
        });
      }
    }
  } else {
    // No context filter, but add context info to all results
    for (const result of results) {
      if (!result.metadata?.notePath) continue;
      
      const notePath = join(vaultPath, result.metadata.notePath);
      const noteContext = await manager.findContextForPath(notePath);
      
      contextResults.push({
        notePath: result.metadata.notePath,
        score: result.score || 0,
        excerpt: result.metadata.text || "",
        tags: Array.isArray(result.metadata.tags) ? result.metadata.tags : [],
        context: noteContext ? {
          name: noteContext.context.name,
          path: dirname(noteContext.contextFilePath).replace(vaultPath, '').replace(/^\//, '') || '/',
        } : undefined
      });
    }
  }
  
  // Return top k results
  return contextResults.slice(0, k);
}

/**
 * Get all notes in a specific context
 */
export async function getNotesInContext(contextPath: string, includeSubcontexts: boolean = true): Promise<string[]> {
  const manager = new ContextManager(vaultPath);
  const contextFullPath = join(vaultPath, contextPath);
  
  // Check if context exists
  const context = await manager.loadContext(contextFullPath);
  if (!context) {
    throw new Error(`No context found at path: ${contextPath}`);
  }
  
  // List all notes in the context directory
  const fg = (await import('fast-glob')).default;
  const pattern = includeSubcontexts ? '**/*.md' : '*.md';
  const paths = await fg(pattern, { 
    cwd: contextFullPath, 
    dot: false 
  });
  
  return paths.map(p => join(contextPath, p));
}

// Import required modules
import { join, dirname, resolve } from 'node:path';