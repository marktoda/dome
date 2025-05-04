import { getLogger } from '@dome/common';

/**
 * Generic content sanitization utility
 * Configurable for different content types
 */
export function createContentSanitizer(options: {
  logger?: any;
  component?: string;
  replacementPatterns?: Array<{ pattern: RegExp; replacement: string }>;
  whitelistPattern?: RegExp;
  neutralizationPatterns?: Array<{ pattern: RegExp; replacement: string }>;
}) {
  const {
    logger = getLogger(),
    component = 'ContentSanitizer',
    replacementPatterns = [],
    whitelistPattern,
    neutralizationPatterns = [],
  } = options;

  const log = component ? logger.child({ component }) : logger;

  return function sanitizeContent(content: string): string {
    if (!content) return '';

    try {
      // Begin with the original content
      let sanitized = content;

      // Apply replacement patterns (e.g., remove URLs, emails, etc.)
      for (const { pattern, replacement } of replacementPatterns) {
        sanitized = sanitized.replace(pattern, replacement);
      }

      // Apply whitelist pattern if provided (keep only matching content)
      if (whitelistPattern) {
        sanitized = sanitized.replace(whitelistPattern, '$1');
      }

      // Apply neutralization patterns (e.g., normalize whitespace)
      for (const { pattern, replacement } of neutralizationPatterns) {
        sanitized = sanitized.replace(pattern, replacement);
      }

      log.debug(
        {
          originalLength: content.length,
          sanitizedLength: sanitized.length,
        },
        'Sanitized content',
      );

      return sanitized;
    } catch (error) {
      log.warn({ error }, 'Error sanitizing content');
      // Return a safe placeholder if sanitation fails
      return '[CONTENT UNAVAILABLE]';
    }
  };
}

/**
 * Pre-configured sanitizer for thinking content
 * Removes potentially problematic patterns and characters that might trigger filters
 */
export const sanitizeThinkingContent = createContentSanitizer({
  component: 'ThinkingHandler',
  replacementPatterns: [
    // Remove URLs
    {
      pattern:
        /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi,
      replacement: '[URL REMOVED]',
    },
  ],
  neutralizationPatterns: [
    // Replace any sequences of special characters that might be problematic
    {
      pattern: /[^\w\s.,;:'"(){}\[\]<>?!@#$%^&*\-+=|\\\/]+/g,
      replacement: ' ',
    },
    // Normalize whitespace
    {
      pattern: /\s+/g,
      replacement: ' ',
    },
  ],
});

/**
 * Pre-configured content pattern detector
 * Determines if content matches certain patterns (e.g., thinking content)
 */
export function createPatternDetector(options: {
  patterns: RegExp[];
  logger?: any;
  component?: string;
}) {
  const { patterns, logger = getLogger(), component = 'PatternDetector' } = options;

  const log = component ? logger.child({ component }) : logger;

  return function detectPattern(content: string): boolean {
    if (!content) return false;

    try {
      return patterns.some(pattern => pattern.test(content));
    } catch (error) {
      log.warn({ error }, 'Error detecting patterns');
      return false;
    }
  };
}

/**
 * Pre-configured detector for thinking content
 * Identifies common thinking patterns in content
 */
export const isThinkingContent = createPatternDetector({
  component: 'ThinkingHandler',
  patterns: [
    // Check for thinking tags
    /<thinking>|<\/thinking>/i,
    // Check for common thinking prefixes
    /^(Let me think about|I'm thinking about|Analyzing|Let's analyze|Let's think step by step)/i,
    // Check for step-by-step reasoning patterns
    /step 1:|first,|to start,|let's start by/i,
  ],
});

/**
 * Process thinking content to make it safe for streaming
 *
 * @param content Potential thinking content
 * @returns Safe version of the content
 */
export function processThinkingContent(content: string): string {
  if (!content) return '';

  const logger = getLogger().child({ component: 'ThinkingHandler' });

  if (isThinkingContent(content)) {
    logger.debug('Detected thinking content, sanitizing');
    return sanitizeThinkingContent(content);
  }

  return content;
}
