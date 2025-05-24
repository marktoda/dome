import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IgnoreFileService } from '../src/services/ignoreFileService';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  createServiceMetrics: vi.fn().mockReturnValue({
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  }),
}));

vi.mock('../src/config/defaultIgnorePatterns', () => ({
  DEFAULT_IGNORE_PATTERNS: [
    '*.log',
    'node_modules/**',
    '.git/**',
    '*.tmp',
  ],
}));

describe('IgnoreFileService', () => {
  let ignoreFileService: IgnoreFileService;

  beforeEach(() => {
    ignoreFileService = new IgnoreFileService();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create IgnoreFileService instance', () => {
      expect(ignoreFileService).toBeInstanceOf(IgnoreFileService);
    });

    it('should load default ignore patterns', () => {
      const patterns = ignoreFileService.getIgnorePatterns();
      expect(patterns).toContain('*.log');
      expect(patterns).toContain('node_modules/**');
      expect(patterns).toContain('.git/**');
    });
  });

  describe('shouldIgnore', () => {
    it('should ignore files matching default patterns', () => {
      expect(ignoreFileService.shouldIgnore('app.log')).toBe(true);
      expect(ignoreFileService.shouldIgnore('node_modules/package/index.js')).toBe(true);
      expect(ignoreFileService.shouldIgnore('.git/config')).toBe(true);
      expect(ignoreFileService.shouldIgnore('temp.tmp')).toBe(true);
    });

    it('should not ignore files not matching patterns', () => {
      expect(ignoreFileService.shouldIgnore('src/index.ts')).toBe(false);
      expect(ignoreFileService.shouldIgnore('README.md')).toBe(false);
      expect(ignoreFileService.shouldIgnore('package.json')).toBe(false);
    });

    it('should handle empty file paths', () => {
      expect(ignoreFileService.shouldIgnore('')).toBe(false);
    });

    it('should handle nested directory patterns', () => {
      expect(ignoreFileService.shouldIgnore('src/node_modules/lib.js')).toBe(true);
      expect(ignoreFileService.shouldIgnore('docs/.git/HEAD')).toBe(true);
    });
  });

  describe('addIgnorePattern', () => {
    it('should add new ignore pattern', () => {
      ignoreFileService.addIgnorePattern('*.test.js');
      
      expect(ignoreFileService.shouldIgnore('app.test.js')).toBe(true);
      expect(ignoreFileService.shouldIgnore('component.test.js')).toBe(true);
    });

    it('should handle duplicate patterns gracefully', () => {
      const initialCount = ignoreFileService.getIgnorePatterns().length;
      
      ignoreFileService.addIgnorePattern('*.log');
      
      expect(ignoreFileService.getIgnorePatterns()).toHaveLength(initialCount + 1);
    });

    it('should handle glob patterns', () => {
      ignoreFileService.addIgnorePattern('dist/**/*.map');
      
      expect(ignoreFileService.shouldIgnore('dist/js/app.js.map')).toBe(true);
      expect(ignoreFileService.shouldIgnore('dist/css/style.css.map')).toBe(true);
      expect(ignoreFileService.shouldIgnore('dist/index.html')).toBe(false);
    });
  });

  describe('removeIgnorePattern', () => {
    it('should remove existing ignore pattern', () => {
      ignoreFileService.addIgnorePattern('*.custom');
      expect(ignoreFileService.shouldIgnore('file.custom')).toBe(true);
      
      ignoreFileService.removeIgnorePattern('*.custom');
      expect(ignoreFileService.shouldIgnore('file.custom')).toBe(false);
    });

    it('should handle removal of non-existent pattern', () => {
      const initialCount = ignoreFileService.getIgnorePatterns().length;
      
      ignoreFileService.removeIgnorePattern('*.nonexistent');
      
      expect(ignoreFileService.getIgnorePatterns()).toHaveLength(initialCount);
    });

    it('should not remove default patterns accidentally', () => {
      ignoreFileService.removeIgnorePattern('*.log');
      
      // Should still have other default patterns
      expect(ignoreFileService.shouldIgnore('node_modules/lib.js')).toBe(true);
    });
  });

  describe('parseIgnoreFile', () => {
    it('should parse .gitignore format correctly', () => {
      const ignoreFileContent = `
# Comments should be ignored
*.log
node_modules/
.env
# Another comment
dist/
*.tmp

# Empty lines should be handled
`;

      const patterns = ignoreFileService.parseIgnoreFile(ignoreFileContent);
      
      expect(patterns).toContain('*.log');
      expect(patterns).toContain('node_modules/');
      expect(patterns).toContain('.env');
      expect(patterns).toContain('dist/');
      expect(patterns).toContain('*.tmp');
      expect(patterns).not.toContain('# Comments should be ignored');
      expect(patterns).not.toContain('');
    });

    it('should handle empty ignore file', () => {
      const patterns = ignoreFileService.parseIgnoreFile('');
      expect(patterns).toEqual([]);
    });

    it('should handle files with only comments', () => {
      const ignoreFileContent = `
# Only comments here
# Nothing else
`;
      const patterns = ignoreFileService.parseIgnoreFile(ignoreFileContent);
      expect(patterns).toEqual([]);
    });

    it('should handle negation patterns', () => {
      const ignoreFileContent = `
*.log
!important.log
`;
      const patterns = ignoreFileService.parseIgnoreFile(ignoreFileContent);
      
      expect(patterns).toContain('*.log');
      expect(patterns).toContain('!important.log');
    });
  });

  describe('loadIgnoreFileFromContent', () => {
    it('should load patterns from ignore file content', () => {
      const ignoreFileContent = `
*.backup
temp/
.cache/
`;
      
      ignoreFileService.loadIgnoreFileFromContent(ignoreFileContent);
      
      expect(ignoreFileService.shouldIgnore('data.backup')).toBe(true);
      expect(ignoreFileService.shouldIgnore('temp/file.txt')).toBe(true);
      expect(ignoreFileService.shouldIgnore('.cache/data')).toBe(true);
    });

    it('should append to existing patterns', () => {
      const initialPatterns = ignoreFileService.getIgnorePatterns();
      
      ignoreFileService.loadIgnoreFileFromContent('*.custom');
      
      const newPatterns = ignoreFileService.getIgnorePatterns();
      expect(newPatterns.length).toBeGreaterThan(initialPatterns.length);
      expect(newPatterns).toContain('*.custom');
    });
  });

  describe('getIgnorePatterns', () => {
    it('should return current ignore patterns', () => {
      const patterns = ignoreFileService.getIgnorePatterns();
      
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns).toContain('*.log');
    });

    it('should return copy of patterns array', () => {
      const patterns1 = ignoreFileService.getIgnorePatterns();
      const patterns2 = ignoreFileService.getIgnorePatterns();
      
      expect(patterns1).toEqual(patterns2);
      expect(patterns1).not.toBe(patterns2); // Different instances
    });
  });

  describe('clearCustomPatterns', () => {
    it('should clear only custom patterns, keep defaults', () => {
      ignoreFileService.addIgnorePattern('*.custom1');
      ignoreFileService.addIgnorePattern('*.custom2');
      
      const beforeClear = ignoreFileService.getIgnorePatterns();
      
      ignoreFileService.clearCustomPatterns();
      
      const afterClear = ignoreFileService.getIgnorePatterns();
      
      expect(afterClear.length).toBeLessThan(beforeClear.length);
      expect(afterClear).toContain('*.log'); // Default pattern should remain
      expect(afterClear).not.toContain('*.custom1');
      expect(afterClear).not.toContain('*.custom2');
    });
  });
});