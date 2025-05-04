import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as thinkingHandlerModule from '../../src/utils/thinkingHandler';
const { sanitizeThinkingContent, isThinkingContent, processThinkingContent } =
  thinkingHandlerModule;

describe('ThinkingHandler', () => {
  describe('isThinkingContent', () => {
    it('should identify content with thinking tags', () => {
      expect(isThinkingContent('<thinking>This is thinking content</thinking>')).toBe(true);
    });

    it('should identify content with common thinking patterns', () => {
      expect(isThinkingContent('Let me think about this step by step')).toBe(true);
      expect(isThinkingContent("I'm thinking about how to approach this")).toBe(true);
      expect(isThinkingContent("Let's analyze this problem first")).toBe(true);
      expect(isThinkingContent('First, we need to understand the context')).toBe(true);
    });

    it('should return false for regular content', () => {
      expect(isThinkingContent('This is a regular response')).toBe(false);
      expect(isThinkingContent('Here is your answer: 42')).toBe(false);
    });

    it('should handle empty or undefined input', () => {
      expect(isThinkingContent('')).toBe(false);
      expect(isThinkingContent(undefined as unknown as string)).toBe(false);
    });
  });

  describe('sanitizeThinkingContent', () => {
    beforeEach(() => {
      // Mock logger to avoid cluttering test output
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should sanitize URLs in thinking content', () => {
      const content = 'Check this resource: https://example.com/sensitive-data?token=12345';
      const sanitized = sanitizeThinkingContent(content);
      expect(sanitized).not.toContain('https://example.com');
      expect(sanitized).toContain('[URL REMOVED]');
    });

    it('should handle special character sequences', () => {
      const content = 'Looking at this sequence: !!!@@###$$$%%%^^^&&&***';
      const sanitized = sanitizeThinkingContent(content);
      expect(sanitized).not.toContain('!!!@@###$$$%%%^^^&&&***');
    });

    it('should preserve normal alphanumeric text and basic punctuation', () => {
      const content = 'This is normal text with numbers 123 and punctuation.';
      const sanitized = sanitizeThinkingContent(content);
      expect(sanitized).toContain('This is normal text with numbers 123 and punctuation.');
    });

    it('should normalize whitespace', () => {
      const content = 'Too    many    spaces    between    words';
      const sanitized = sanitizeThinkingContent(content);
      expect(sanitized).not.toContain('    ');
    });

    it('should handle empty or undefined input', () => {
      expect(sanitizeThinkingContent('')).toBe('');
      expect(sanitizeThinkingContent(undefined as unknown as string)).toBe('');
    });
  });

  describe('processThinkingContent', () => {
    it('should process thinking content', () => {
      const spy = vi.spyOn(thinkingHandlerModule, 'isThinkingContent').mockReturnValue(true);
      const sanitizeSpy = vi
        .spyOn(thinkingHandlerModule, 'sanitizeThinkingContent')
        .mockReturnValue('Sanitized content');

      const result = processThinkingContent('<thinking>Raw thinking content</thinking>');

      expect(spy).toHaveBeenCalled();
      expect(sanitizeSpy).toHaveBeenCalled();
      expect(result).toBe('Sanitized content');

      spy.mockRestore();
      sanitizeSpy.mockRestore();
    });

    it('should return original content if not thinking content', () => {
      const spy = vi.spyOn(thinkingHandlerModule, 'isThinkingContent').mockReturnValue(false);
      const sanitizeSpy = vi.spyOn(thinkingHandlerModule, 'sanitizeThinkingContent');

      const originalContent = 'Regular content';
      const result = processThinkingContent(originalContent);

      expect(spy).toHaveBeenCalled();
      expect(sanitizeSpy).not.toHaveBeenCalled();
      expect(result).toBe(originalContent);

      spy.mockRestore();
      sanitizeSpy.mockRestore();
    });

    it('should handle empty content', () => {
      expect(processThinkingContent('')).toBe('');
      expect(processThinkingContent(undefined as unknown as string)).toBe('');
    });
  });
});
