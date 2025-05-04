import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createContentSanitizer,
  sanitizeThinkingContent,
  createPatternDetector,
  isThinkingContent,
  processThinkingContent,
} from '../../src/utils/contentSanitizers';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  })),
}));

describe('Content Sanitizers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createContentSanitizer', () => {
    it('should create a sanitizer function', () => {
      const sanitizer = createContentSanitizer({});
      expect(typeof sanitizer).toBe('function');
    });

    it('should return empty string for empty input', () => {
      const sanitizer = createContentSanitizer({});
      expect(sanitizer('')).toBe('');
      expect(sanitizer(null as any)).toBe('');
      expect(sanitizer(undefined as any)).toBe('');
    });

    it('should apply replacement patterns', () => {
      const sanitizer = createContentSanitizer({
        replacementPatterns: [
          { pattern: /test/g, replacement: 'replaced' },
          { pattern: /\d+/g, replacement: '[NUMBER]' },
        ],
      });

      expect(sanitizer('this is a test with 123')).toBe('this is a replaced with [NUMBER]');
    });

    it('should apply whitelist pattern if provided', () => {
      const sanitizer = createContentSanitizer({
        whitelistPattern: /([a-z\s]+)/gi,
      });

      expect(sanitizer('abc 123 !@#')).toBe('abc  ');
    });

    it('should apply neutralization patterns', () => {
      const sanitizer = createContentSanitizer({
        neutralizationPatterns: [
          { pattern: /\s+/g, replacement: ' ' },
          { pattern: /[!@#$%^&*()]/g, replacement: '' },
        ],
      });

      expect(sanitizer('too    many   spaces and !@#$%^&*() symbols')).toBe(
        'too many spaces and  symbols',
      );
    });

    it('should handle errors gracefully', () => {
      const mockLogger: {
        debug: any;
        warn: any;
        info: any;
        error: any;
        child: any;
      } = {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        child: vi.fn(() => mockLogger),
      };

      const sanitizer = createContentSanitizer({
        logger: mockLogger,
        replacementPatterns: [
          // Invalid regex that will throw an error when used
          { pattern: {} as RegExp, replacement: 'replaced' },
        ],
      });

      expect(sanitizer('test content')).toBe('[CONTENT UNAVAILABLE]');
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('sanitizeThinkingContent', () => {
    it('should remove URLs', () => {
      const result = sanitizeThinkingContent(
        'Check this link: https://example.com/test?param=value',
      );
      expect(result).not.toContain('https://');
      expect(result).toContain('[URL REMOVED]');
    });

    it('should normalize whitespace', () => {
      const result = sanitizeThinkingContent('Too    many   spaces');
      expect(result).toBe('Too many spaces');
    });

    it('should replace problematic character sequences', () => {
      const result = sanitizeThinkingContent('Some text with ████████ redacted content');
      expect(result).not.toContain('████████');
    });
  });

  describe('createPatternDetector', () => {
    it('should create a detector function', () => {
      const detector = createPatternDetector({
        patterns: [/test/],
      });
      expect(typeof detector).toBe('function');
    });

    it('should return false for empty input', () => {
      const detector = createPatternDetector({
        patterns: [/test/],
      });
      expect(detector('')).toBe(false);
      expect(detector(null as any)).toBe(false);
      expect(detector(undefined as any)).toBe(false);
    });

    it('should return true if any pattern matches', () => {
      const detector = createPatternDetector({
        patterns: [/test/, /example/],
      });
      expect(detector('this is a test')).toBe(true);
      expect(detector('this is an example')).toBe(true);
      expect(detector('this has neither')).toBe(false);
    });

    it('should handle errors gracefully', () => {
      const mockLogger: {
        debug: any;
        warn: any;
        info: any;
        error: any;
        child: any;
      } = {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        child: vi.fn(() => mockLogger),
      };

      const detector = createPatternDetector({
        logger: mockLogger,
        patterns: [
          // Invalid regex that will throw an error when used
          {} as RegExp,
        ],
      });

      expect(detector('test content')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('isThinkingContent', () => {
    it('should detect thinking tags', () => {
      expect(isThinkingContent('<thinking>Some thoughts</thinking>')).toBe(true);
      expect(isThinkingContent('Content with <thinking> tag')).toBe(true);
    });

    it('should detect thinking prefixes', () => {
      expect(isThinkingContent('Let me think about this problem')).toBe(true);
      expect(isThinkingContent("I'm thinking about the solution")).toBe(true);
      expect(isThinkingContent('Analyzing the data provided')).toBe(true);
    });

    it('should detect step-by-step reasoning', () => {
      expect(isThinkingContent('Step 1: Understand the problem')).toBe(true);
      expect(isThinkingContent('First, we need to identify the variables')).toBe(true);
      expect(isThinkingContent("Let's start by breaking down the requirements")).toBe(true);
    });

    it('should return false for regular content', () => {
      expect(isThinkingContent('This is a normal response')).toBe(false);
      expect(isThinkingContent('Hello, how can I help you today?')).toBe(false);
    });
  });

  describe('processThinkingContent', () => {
    it('should return empty string for empty input', () => {
      expect(processThinkingContent('')).toBe('');
      expect(processThinkingContent(null as any)).toBe('');
      expect(processThinkingContent(undefined as any)).toBe('');
    });

    it('should sanitize thinking content', () => {
      const mockSanitizeThinkingContent = vi
        .spyOn({ sanitizeThinkingContent }, 'sanitizeThinkingContent')
        .mockReturnValue('sanitized content');

      const mockIsThinkingContent = vi
        .spyOn({ isThinkingContent }, 'isThinkingContent')
        .mockReturnValue(true);

      expect(processThinkingContent('<thinking>Test content</thinking>')).toBe('sanitized content');

      expect(mockIsThinkingContent).toHaveBeenCalled();
      expect(mockSanitizeThinkingContent).toHaveBeenCalled();

      mockSanitizeThinkingContent.mockRestore();
      mockIsThinkingContent.mockRestore();
    });

    it('should return original content if not thinking content', () => {
      const mockSanitizeThinkingContent = vi.spyOn(
        { sanitizeThinkingContent },
        'sanitizeThinkingContent',
      );

      const mockIsThinkingContent = vi
        .spyOn({ isThinkingContent }, 'isThinkingContent')
        .mockReturnValue(false);

      const content = 'Regular content';
      expect(processThinkingContent(content)).toBe(content);

      expect(mockIsThinkingContent).toHaveBeenCalled();
      expect(mockSanitizeThinkingContent).not.toHaveBeenCalled();

      mockSanitizeThinkingContent.mockRestore();
      mockIsThinkingContent.mockRestore();
    });
  });
});
