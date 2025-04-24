/**
 * Ignore Pattern Processor
 *
 * This utility provides functionality for matching file paths against
 * ignore patterns similar to .gitignore or .dockerignore files.
 *
 * @module utils/ignorePatternProcessor
 */

import { getLogger } from '@dome/logging';

/**
 * Class for processing and matching ignore patterns against file paths
 */
export class IgnorePatternProcessor {
  private patterns: string[] = [];
  private logger = getLogger();

  /**
   * Creates a new IgnorePatternProcessor instance
   * 
   * @param patterns - Initial patterns to use (optional)
   */
  constructor(patterns: string[] = []) {
    this.addPatterns(patterns);
  }

  /**
   * Add patterns to the processor
   * 
   * @param patterns - Array of patterns to add
   */
  addPatterns(patterns: string[]): void {
    // Filter out empty lines and comments
    const validPatterns = patterns.filter(pattern => {
      const trimmed = pattern.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    });

    this.patterns.push(...validPatterns);
    this.logger.debug({ patternCount: this.patterns.length }, 'Added ignore patterns');
  }

  /**
   * Clear all patterns from the processor
   */
  clearPatterns(): void {
    this.patterns = [];
    this.logger.debug('Cleared all ignore patterns');
  }

  /**
   * Check if a file path matches any of the ignore patterns
   * 
   * @param filePath - The file path to check
   * @returns True if the path should be ignored, false otherwise
   */
  shouldIgnore(filePath: string): boolean {
    // Normalize path for consistent matching
    const normalizedPath = filePath.trim().replace(/^\/+/, '');
    
    for (const pattern of this.patterns) {
      if (this.matchesPattern(normalizedPath, pattern)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if a file path matches a specific pattern
   * 
   * @param filePath - The file path to check
   * @param pattern - The pattern to match against
   * @returns True if the path matches the pattern, false otherwise
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    // Handle negation patterns (patterns starting with !)
    if (pattern.startsWith('!')) {
      return !this.matchesPattern(filePath, pattern.slice(1));
    }

    // Normalize pattern
    let normalizedPattern = pattern.trim().replace(/^\/+/, '');
    
    // Handle directory-specific patterns (ending with /)
    const isDirectoryPattern = normalizedPattern.endsWith('/');
    if (isDirectoryPattern) {
      normalizedPattern = normalizedPattern.slice(0, -1);
    }

    // Convert glob pattern to regex
    let regexPattern = this.globToRegex(normalizedPattern);
    
    // For directory patterns, ensure it matches directories
    if (isDirectoryPattern) {
      regexPattern = new RegExp(`^${regexPattern}(?:/|$)`);
    }
    
    // For patterns with no wildcards that don't end with /, match files and directories
    if (!pattern.includes('*') && !pattern.includes('?') && !isDirectoryPattern) {
      // Match exact file or any file in directory with this name
      return filePath === normalizedPattern || filePath.startsWith(`${normalizedPattern}/`);
    }
    
    return regexPattern.test(filePath);
  }

  /**
   * Convert a glob pattern to a regular expression
   * 
   * @param pattern - The glob pattern to convert
   * @returns A RegExp object representing the pattern
   */
  private globToRegex(pattern: string): RegExp {
    let regexString = '';
    
    // Handle ** pattern (matches any number of directories)
    if (pattern.includes('**')) {
      regexString = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOUBLE_ASTERISK}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/{{DOUBLE_ASTERISK}}/g, '.*');
    } else {
      // Handle standard glob patterns (* and ?)
      regexString = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    }
    
    return new RegExp(`^${regexString}$`);
  }

  /**
   * Get the current list of patterns
   * 
   * @returns Array of current patterns
   */
  getPatterns(): string[] {
    return [...this.patterns];
  }
}