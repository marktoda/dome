/**
 * Context Manager for the Dome vault system.
 * Handles loading, merging, and applying folder-based contexts.
 */

import { join, dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import type { 
  DomeContext, 
  ValidationResult, 
  ValidationError, 
  ValidationWarning,
  ContextSearchResult, 
  ContextLoadOptions 
} from './types.js';
import { 
  readContextFile, 
  writeContextFile, 
  findNearestContextFile, 
  listContextFiles 
} from './parser.js';

/**
 * Manages context configurations for the Dome vault
 */
export class ContextManager {
  private readonly vaultPath: string;
  
  /**
   * Create a new context manager
   * @param vaultPath - Optional custom vault path (defaults to DOME_VAULT_PATH env or ~/dome)
   */
  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath || 
      process.env.DOME_VAULT_PATH || 
      `${process.env.HOME}/dome`;
  }
  
  /**
   * Load a context from a specific folder
   * @param folderPath - Absolute path to the folder
   * @returns Context configuration or null if not found
   */
  async loadContext(folderPath: string): Promise<DomeContext | null> {
    const contextPath = join(folderPath, '.dome');
    return await readContextFile(contextPath);
  }
  
  /**
   * Find the context that applies to a given note path
   * @param notePath - Path to the note file
   * @param options - Search options (inheritance, max depth)
   * @returns Context search result with inheritance info
   */
  async findContextForPath(
    notePath: string, 
    options?: ContextLoadOptions
  ): Promise<ContextSearchResult | null> {
    const inheritFromParent = options?.inheritFromParent ?? true;
    const maxDepth = options?.maxDepth ?? 10;
    
    // Start from the note's directory
    const startDir = dirname(resolve(notePath));
    
    if (!inheritFromParent) {
      // Only check immediate directory
      const context = await this.loadContext(startDir);
      if (context) {
        return {
          context,
          contextFilePath: join(startDir, '.dome'),
          isInherited: false,
          depth: 0,
        };
      }
      return null;
    }
    
    // Search up the directory tree
    const result = await findNearestContextFile(startDir, maxDepth);
    if (!result) return null;
    
    const context = await readContextFile(result.path);
    if (!context) return null;
    
    return {
      context,
      contextFilePath: result.path,
      isInherited: result.depth > 0,
      depth: result.depth,
    };
  }
  
  /**
   * Get merged context combining all parent contexts
   * @param notePath - Path to the note
   * @param maxDepth - Maximum levels to search up
   * @returns Merged context from all parents
   */
  async getMergedContext(
    notePath: string, 
    maxDepth: number = 10
  ): Promise<DomeContext | null> {
    const contexts: DomeContext[] = [];
    let currentDir = dirname(resolve(notePath));
    let depth = 0;
    
    // Collect contexts from current to root
    while (depth < maxDepth) {
      const context = await this.loadContext(currentDir);
      if (context) {
        contexts.unshift(context); // Parent first
      }
      
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break; // Reached root
      
      currentDir = parentDir;
      depth++;
    }
    
    if (contexts.length === 0) return null;
    
    // Merge from parent to child
    return contexts.reduce((merged, context) => 
      this.mergeContexts(merged, context)
    );
  }
  
  /**
   * Create a new context in a folder
   * @param folderPath - Absolute path to the folder
   * @param context - Context configuration to save
   */
  async createContext(
    folderPath: string, 
    context: DomeContext
  ): Promise<void> {
    const contextPath = join(folderPath, '.dome');
    await writeContextFile(contextPath, context);
  }
  
  /**
   * Validate a note against its context rules
   * @param notePath - Path to the note
   * @param content - Note content to validate
   * @returns Validation result with errors and warnings
   */
  async validateNoteAgainstContext(
    notePath: string, 
    content: string
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    // Find applicable context
    const contextResult = await this.findContextForPath(notePath);
    if (!contextResult) {
      // No context = always valid
      return { isValid: true, errors: [], warnings: [] };
    }
    
    const { context } = contextResult;
    const { data: frontmatter } = matter(content);
    
    // Check required fields
    if (context.rules?.requiredFields) {
      for (const field of context.rules.requiredFields) {
        if (!(field in frontmatter)) {
          errors.push({
            type: 'missing_field',
            message: `Required field '${field}' is missing`,
            field,
          });
        }
      }
    }
    
    // Check filename pattern
    if (context.rules?.fileNaming) {
      const filename = notePath.split('/').pop() || '';
      if (!this.validateFilename(filename, context.rules.fileNaming)) {
        errors.push({
          type: 'invalid_filename',
          message: `Filename doesn't match pattern: ${context.rules.fileNaming}`,
        });
      }
    }
    
    // Check for missing auto-tags
    if (context.rules?.autoTags?.length) {
      const noteTags = frontmatter.tags || [];
      const missingTags = context.rules.autoTags.filter(
        tag => !noteTags.includes(tag)
      );
      
      if (missingTags.length > 0) {
        warnings.push({
          type: 'suggested_field',
          message: `Consider adding these tags: ${missingTags.join(', ')}`,
          field: 'tags',
        });
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
  
  /**
   * List all contexts in the vault
   * @returns Array of context paths and configurations
   */
  async listContexts(): Promise<Array<{
    path: string;
    context: DomeContext | null;
  }>> {
    const contextFiles = await listContextFiles(this.vaultPath);
    
    const contexts = await Promise.all(
      contextFiles.map(async (filePath) => ({
        path: dirname(filePath)
          .replace(this.vaultPath, '')
          .replace(/^\//, '') || '/',
        context: await readContextFile(filePath),
      }))
    );
    
    return contexts.filter(c => c.context !== null);
  }
  
  /**
   * Apply a context template to generate note content
   * @param context - Context with template
   * @param variables - Variables to replace in template
   * @returns Generated note content with frontmatter
   */
  applyTemplate(
    context: DomeContext, 
    variables: Record<string, any>
  ): string {
    const frontmatter: Record<string, any> = {};
    
    // Start with template frontmatter
    if (context.template?.frontmatter) {
      Object.assign(frontmatter, context.template.frontmatter);
    }
    
    // Add auto-tags
    if (context.rules?.autoTags?.length) {
      frontmatter.tags = [
        ...(frontmatter.tags || []), 
        ...context.rules.autoTags
      ];
    }
    
    // Apply variables to frontmatter
    for (const [key, value] of Object.entries(variables)) {
      if (key !== 'content' && key !== 'body') {
        frontmatter[key] = value;
      }
    }
    
    // Process content template
    let content = context.template?.content || '';
    for (const [key, value] of Object.entries(variables)) {
      content = content.replace(
        new RegExp(`\\{${key}\\}`, 'g'), 
        String(value)
      );
    }
    
    return matter.stringify(content, frontmatter);
  }
  
  /**
   * Generate a filename based on context rules
   * @param context - Context with naming rules
   * @param title - Note title
   * @returns Generated filename with .md extension
   */
  generateFilename(context: DomeContext, title: string): string {
    if (!context.rules?.fileNaming) {
      // Default: slugified title
      return `${this.slugify(title)}.md`;
    }
    
    const now = new Date();
    const pattern = context.rules.fileNaming;
    
    return pattern
      .replace(/YYYY/g, now.getFullYear().toString())
      .replace(/MM/g, String(now.getMonth() + 1).padStart(2, '0'))
      .replace(/DD/g, String(now.getDate()).padStart(2, '0'))
      .replace(/HH/g, String(now.getHours()).padStart(2, '0'))
      .replace(/mm/g, String(now.getMinutes()).padStart(2, '0'))
      .replace(/ss/g, String(now.getSeconds()).padStart(2, '0'))
      .replace(/\{title\}/g, this.slugify(title))
      .replace(/\{date\}/g, now.toISOString().split('T')[0])
      .replace(/\{time\}/g, now.toTimeString().split(' ')[0].replace(/:/g, ''))
      .replace(/\{uuid\}/g, this.generateShortId())
      + '.md';
  }
  
  /**
   * Merge two contexts with child overriding parent
   */
  private mergeContexts(
    parent: DomeContext, 
    child: DomeContext
  ): DomeContext {
    return {
      name: child.name,
      description: child.description,
      template: {
        frontmatter: {
          ...parent.template?.frontmatter,
          ...child.template?.frontmatter,
        },
        content: child.template?.content || parent.template?.content,
      },
      rules: {
        fileNaming: child.rules?.fileNaming || parent.rules?.fileNaming,
        requiredFields: this.mergeArrays(
          parent.rules?.requiredFields,
          child.rules?.requiredFields
        ),
        autoTags: this.mergeArrays(
          parent.rules?.autoTags,
          child.rules?.autoTags
        ),
      },
      aiInstructions: child.aiInstructions || parent.aiInstructions,
    };
  }
  
  /**
   * Merge two arrays removing duplicates
   */
  private mergeArrays<T>(
    parent?: T[], 
    child?: T[]
  ): T[] | undefined {
    if (!parent && !child) return undefined;
    const merged = [...(parent || []), ...(child || [])];
    return [...new Set(merged)];
  }
  
  /**
   * Validate filename against pattern (simplified)
   */
  private validateFilename(filename: string, pattern: string): boolean {
    // Basic check - just ensure it ends with .md
    return filename.endsWith('.md');
  }
  
  /**
   * Convert title to URL-safe slug
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
  
  /**
   * Generate a short random ID
   */
  private generateShortId(): string {
    return Math.random().toString(36).substring(2, 8);
  }
}