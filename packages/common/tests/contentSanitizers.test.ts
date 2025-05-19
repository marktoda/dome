import { describe, it, expect } from 'vitest';
import {
  createContentSanitizer,
  sanitizeThinkingContent,
  isThinkingContent,
  processThinkingContent,
} from '../src/utils/contentSanitizers';

describe('createContentSanitizer', () => {
  it('applies replacement and neutralization patterns', () => {
    const sanitize = createContentSanitizer({
      replacementPatterns: [{ pattern: /foo/gi, replacement: '' }],
      neutralizationPatterns: [{ pattern: /\s+/g, replacement: ' ' }],
    });

    const result = sanitize('foo FOO bar');
    expect(result.trim()).toBe('bar');
  });
});

describe('thinking helpers', () => {
  it('sanitizes thinking content with default rules', () => {
    const raw = 'Check this https://example.com <thinking>Let me think</thinking>';
    const sanitized = sanitizeThinkingContent(raw);
    expect(sanitized).not.toMatch(/https?:/);
    // thinking tags are preserved but content is sanitized
    expect(sanitized).toContain('<thinking>');
  });

  it('detects thinking patterns and processes content accordingly', () => {
    const text = 'Let\'s think step by step';
    expect(isThinkingContent(text)).toBe(true);
    const processed = processThinkingContent(text);
    expect(processed).not.toContain("http");
  });

  it('returns original content when not thinking content', () => {
    const text = 'Normal output';
    expect(isThinkingContent(text)).toBe(false);
    expect(processThinkingContent(text)).toBe(text);
  });
});
