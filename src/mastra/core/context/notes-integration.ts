/**
 * Context-aware note writing functions
 */

import { join, dirname, basename, extname } from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { ContextManager } from './manager.js';
import type { Note } from '../notes.js';

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

export interface ContextAwareWriteOptions {
  path: string;
  content: string;
  title?: string;
  tags?: string[];
  respectContext?: boolean;
  variables?: Record<string, any>;
}

export interface ContextAwareWriteResult {
  path: string;
  title: string;
  action: "created" | "appended";
  contentLength: number;
  fullPath: string;
  contextApplied?: boolean;
  contextName?: string;
}

/**
 * Write a note with context awareness
 */
export async function writeNoteWithContext(options: ContextAwareWriteOptions): Promise<ContextAwareWriteResult> {
  const { path, content, title, tags = [], respectContext = true, variables = {} } = options;
  const fullPath = join(vaultPath, path);
  
  try {
    // Ensure directory exists
    await fs.mkdir(dirname(fullPath), { recursive: true });
    
    // Check if note already exists
    const exists = await fs.access(fullPath).then(() => true).catch(() => false);
    
    if (exists) {
      // For existing notes, just append content (don't apply context rules)
      const { data: frontMatter, content: currentContent } = matter(await fs.readFile(fullPath, 'utf8'));
      
      // Append new content with proper spacing
      const separator = currentContent.trim() ? '\n\n' : '';
      const updatedContent = currentContent + separator + content;
      
      // Update modified timestamp
      const updatedFrontMatter = {
        ...frontMatter,
        modified: new Date().toISOString()
      };
      
      // Write updated file
      const updatedFileContent = matter.stringify(updatedContent, updatedFrontMatter);
      await fs.writeFile(fullPath, updatedFileContent, 'utf8');
      
      return {
        path,
        title: frontMatter.title || basename(path, extname(path)),
        action: "appended",
        contentLength: content.length,
        fullPath,
        contextApplied: false
      };
    }
    
    // For new notes, check for context
    if (respectContext) {
      const manager = new ContextManager(vaultPath);
      const contextResult = await manager.findContextForPath(fullPath);
      
      if (contextResult) {
        const { context } = contextResult;
        
        // Generate filename if needed
        let finalPath = path;
        if (context.rules?.fileNaming && !path.endsWith('.md')) {
          const noteTitle = title || 'untitled';
          const filename = manager.generateFilename(context, noteTitle);
          finalPath = join(dirname(path), filename);
        }
        
        const finalFullPath = join(vaultPath, finalPath);
        
        // Apply context template
        const templateVars = {
          ...variables,
          title: title || basename(finalPath, extname(finalPath)),
          date: new Date().toISOString().split('T')[0],
          time: new Date().toTimeString().split(' ')[0],
          content,
        };
        
        // Generate note content with template
        let noteContent: string;
        if (context.template?.content || context.template?.frontmatter) {
          // Use template
          const templatedContent = manager.applyTemplate(context, templateVars);
          
          // If content was provided, append it to the templated content
          if (content.trim()) {
            const { data: frontMatter, content: templateBody } = matter(templatedContent);
            const finalContent = templateBody.trim() ? `${templateBody}\n\n${content}` : content;
            noteContent = matter.stringify(finalContent, frontMatter);
          } else {
            noteContent = templatedContent;
          }
        } else {
          // No template, create with context rules
          const frontMatter: Record<string, any> = {
            title: templateVars.title,
            date: new Date().toISOString(),
            tags: [...tags, ...(context.rules?.autoTags || [])],
            source: "cli"
          };
          
          noteContent = matter.stringify(content, frontMatter);
        }
        
        // Write the file
        await fs.writeFile(finalFullPath, noteContent, 'utf8');
        
        return {
          path: finalPath,
          title: templateVars.title,
          action: "created",
          contentLength: noteContent.length,
          fullPath: finalFullPath,
          contextApplied: true,
          contextName: context.name
        };
      }
    }
    
    // No context or context disabled - use default behavior
    const now = new Date();
    const noteTitle = title || basename(path, extname(path));
    
    const frontMatter = {
      title: noteTitle,
      date: now.toISOString(),
      tags,
      source: "cli"
    };
    
    const fileContent = matter.stringify(content, frontMatter);
    await fs.writeFile(fullPath, fileContent, 'utf8');
    
    return {
      path,
      title: noteTitle,
      action: "created",
      contentLength: content.length,
      fullPath,
      contextApplied: false
    };
    
  } catch (error) {
    console.error("Error writing note with context:", error);
    throw new Error(`Failed to write note: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}