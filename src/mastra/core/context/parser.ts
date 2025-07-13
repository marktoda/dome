/**
 * Parser for .dome context configuration files
 */

import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';
import type { DomeContext } from './types.js';
import { parseContextYaml } from './schema.js';

/**
 * Read and parse a .dome configuration file
 */
export async function readContextFile(filePath: string): Promise<DomeContext | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Parse YAML content
    const parsed = matter(content);
    const contextData = parsed.data;
    
    // If there's content after frontmatter, add it as aiInstructions if not already set
    if (parsed.content.trim() && !contextData.aiInstructions) {
      contextData.aiInstructions = parsed.content.trim();
    }
    
    // Validate and parse the context
    const result = parseContextYaml(contextData);
    
    if (result.success) {
      return result.data;
    } else {
      console.error(`Invalid context file at ${filePath}:`, result.error);
      return null;
    }
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return null;
    }
    console.error(`Error reading context file at ${filePath}:`, error);
    return null;
  }
}

/**
 * Write a context configuration to a .dome file
 */
export async function writeContextFile(filePath: string, context: DomeContext): Promise<void> {
  // Prepare the data for YAML
  const yamlData: any = {
    name: context.name,
    description: context.description,
  };
  
  if (context.template) {
    yamlData.template = context.template;
  }
  
  if (context.rules) {
    yamlData.rules = context.rules;
  }
  
  // Use aiInstructions as content if present
  const content = context.aiInstructions || '';
  
  // Create YAML content with frontmatter
  const fileContent = matter.stringify(content, yamlData);
  
  // Ensure directory exists
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  
  // Write the file
  await fs.writeFile(filePath, fileContent, 'utf-8');
}

/**
 * Check if a .dome file exists at the given path
 */
export async function contextFileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Find the nearest .dome file by walking up the directory tree
 */
export async function findNearestContextFile(startPath: string, maxDepth: number = 10): Promise<{ path: string; depth: number } | null> {
  let currentPath = startPath;
  let depth = 0;
  
  while (depth < maxDepth) {
    const contextPath = join(currentPath, '.dome');
    
    if (await contextFileExists(contextPath)) {
      return { path: contextPath, depth };
    }
    
    const parentPath = dirname(currentPath);
    
    // Stop if we've reached the root
    if (parentPath === currentPath) {
      break;
    }
    
    currentPath = parentPath;
    depth++;
  }
  
  return null;
}

/**
 * List all .dome files in a directory tree
 */
export async function listContextFiles(rootPath: string): Promise<string[]> {
  const contextFiles: string[] = [];
  
  async function scanDirectory(dirPath: string) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await scanDirectory(fullPath);
        } else if (entry.isFile() && entry.name === '.dome') {
          contextFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dirPath}:`, error);
    }
  }
  
  await scanDirectory(rootPath);
  return contextFiles;
}