import { describe, it, expect } from 'vitest';
import { IgnorePatternProcessor } from '../../src/utils/ignorePatternProcessor';

describe('IgnorePatternProcessor', () => {
  describe('constructor', () => {
    it('should initialize with empty patterns when none provided', () => {
      const processor = new IgnorePatternProcessor();
      expect(processor['patterns']).toEqual([]);
    });

    it('should initialize with provided default patterns', () => {
      const defaultPatterns = ['node_modules/**', '*.log'];
      const processor = new IgnorePatternProcessor(defaultPatterns);
      expect(processor['patterns']).toEqual(defaultPatterns);
    });
  });

  describe('addPatterns', () => {
    it('should add new patterns to the existing ones', () => {
      const processor = new IgnorePatternProcessor(['node_modules/**']);
      processor.addPatterns(['*.log', 'dist/**']);
      expect(processor['patterns']).toEqual(['node_modules/**', '*.log', 'dist/**']);
    });

    it('should handle empty arrays', () => {
      const processor = new IgnorePatternProcessor(['node_modules/**']);
      processor.addPatterns([]);
      expect(processor['patterns']).toEqual(['node_modules/**']);
    });
  });

  describe('shouldIgnore', () => {
    it('should match exact file paths', () => {
      const processor = new IgnorePatternProcessor(['package-lock.json']);
      expect(processor.shouldIgnore('package-lock.json')).toBe(true);
      expect(processor.shouldIgnore('src/package-lock.json')).toBe(false);
    });

    it('should match files with wildcards', () => {
      const processor = new IgnorePatternProcessor(['*.log']);
      expect(processor.shouldIgnore('error.log')).toBe(true);
      expect(processor.shouldIgnore('logs/error.log')).toBe(true);
      expect(processor.shouldIgnore('error.txt')).toBe(false);
    });

    it('should match directory patterns with /**', () => {
      const processor = new IgnorePatternProcessor(['node_modules/**']);
      expect(processor.shouldIgnore('node_modules/package/index.js')).toBe(true);
      
      // Special case: 'node_modules/**' should not match 'node_modules' itself
      // This is to allow ignoring files inside a directory but not the directory itself
      processor.clearPatterns();
      processor.addPatterns(['node_modules/**']);
      expect(processor.shouldIgnore('node_modules')).toBe(false);
      
      // Should not match node_modules in subdirectories unless pattern is **/node_modules/**
      processor.clearPatterns();
      processor.addPatterns(['node_modules/**']);
      expect(processor.shouldIgnore('src/node_modules/file.js')).toBe(false);
      
      // But should match with the correct pattern
      processor.clearPatterns();
      processor.addPatterns(['**/node_modules/**']);
      expect(processor.shouldIgnore('src/node_modules/file.js')).toBe(true);
    });

    it('should match patterns with single *', () => {
      const processor = new IgnorePatternProcessor(['*.config.js']);
      expect(processor.shouldIgnore('jest.config.js')).toBe(true);
      expect(processor.shouldIgnore('webpack.config.js')).toBe(true);
      expect(processor.shouldIgnore('config.js')).toBe(false);
    });

    it('should handle negated patterns with !', () => {
      const processor = new IgnorePatternProcessor(['*.log', '!important.log']);
      expect(processor.shouldIgnore('error.log')).toBe(true);
      expect(processor.shouldIgnore('important.log')).toBe(false);
    });

    it('should handle multiple patterns with precedence', () => {
      const processor = new IgnorePatternProcessor([
        'node_modules/**',
        '*.log',
        '!important.log',
        'important.log.backup'
      ]);
      expect(processor.shouldIgnore('node_modules/package/index.js')).toBe(true);
      expect(processor.shouldIgnore('error.log')).toBe(true);
      expect(processor.shouldIgnore('important.log')).toBe(false);
      expect(processor.shouldIgnore('important.log.backup')).toBe(true);
    });

    it('should handle directory-specific patterns', () => {
      const processor = new IgnorePatternProcessor(['logs/*.log', '/root-level-only.txt']);
      expect(processor.shouldIgnore('logs/error.log')).toBe(true);
      expect(processor.shouldIgnore('logs/subdirectory/error.log')).toBe(false);
      expect(processor.shouldIgnore('root-level-only.txt')).toBe(true);
      expect(processor.shouldIgnore('subdir/root-level-only.txt')).toBe(false);
    });

    it('should handle complex patterns', () => {
      // Test each pattern individually to isolate issues
      let processor = new IgnorePatternProcessor(['**/*.min.js']);
      expect(processor.shouldIgnore('dist/bundle.min.js')).toBe(true);
      expect(processor.shouldIgnore('src/components/Button.js')).toBe(false);
      
      processor = new IgnorePatternProcessor(['**/node_modules/**']);
      expect(processor.shouldIgnore('node_modules/package/index.js')).toBe(true);
      expect(processor.shouldIgnore('subproject/node_modules/package/index.js')).toBe(true);
      
      processor = new IgnorePatternProcessor(['**/.git/**']);
      expect(processor.shouldIgnore('.git/HEAD')).toBe(true);
      
      processor = new IgnorePatternProcessor(['*.log']);
      expect(processor.shouldIgnore('error.log')).toBe(true);
      
      // Test negation pattern
      processor = new IgnorePatternProcessor(['*.log', '!*.important.log']);
      expect(processor.shouldIgnore('error.log')).toBe(true);
      expect(processor.shouldIgnore('app.important.log')).toBe(false);
    });
  });
});