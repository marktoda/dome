import { getLogger } from '@dome/common';

const logger = getLogger().child({ component: 'ThinkingHandler' });

/**
 * Sanitizes thinking content to prevent content filter issues
 * Removes potentially problematic patterns and characters that might trigger filters
 * 
 * @param thinkingContent The raw thinking content from the model
 * @returns Sanitized thinking content that won't trigger content filters
 */
export function sanitizeThinkingContent(thinkingContent: string): string {
  if (!thinkingContent) return '';
  
  try {
    // Replace any potentially problematic patterns
    let sanitized = thinkingContent
      // Remove or replace any sequences that might trigger content filters
      .replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi, '[URL REMOVED]')
      // Replace any sequences of special characters that might be problematic
      .replace(/[^\w\s.,;:'"(){}\[\]<>?!@#$%^&*\-+=|\\\/]+/g, ' ')
      // Normalize whitespace
      .replace(/\s+/g, ' ');
      
    logger.debug({ 
      originalLength: thinkingContent.length,
      sanitizedLength: sanitized.length 
    }, 'Sanitized thinking content');
    
    return sanitized;
  } catch (error) {
    logger.warn({ error }, 'Error sanitizing thinking content');
    // Return a safe placeholder if sanitation fails
    return '[THINKING CONTENT UNAVAILABLE]';
  }
}

/**
 * Determines if content appears to be thinking content based on patterns
 * 
 * @param content Content to check
 * @returns True if the content appears to be thinking content
 */
export function isThinkingContent(content: string): boolean {
  if (!content) return false;
  
  // Common patterns that indicate thinking content
  const thinkingPatterns = [
    // Check for thinking tags
    /<thinking>|<\/thinking>/i,
    // Check for common thinking prefixes
    /^(Let me think about|I'm thinking about|Analyzing|Let's analyze|Let's think step by step)/i,
    // Check for step-by-step reasoning patterns
    /step 1:|first,|to start,|let's start by/i
  ];
  
  return thinkingPatterns.some(pattern => pattern.test(content));
}

/**
 * Process thinking content to make it safe for streaming
 * 
 * @param content Potential thinking content
 * @returns Safe version of the content
 */
export function processThinkingContent(content: string): string {
  if (!content) return '';
  
  if (isThinkingContent(content)) {
    logger.debug('Detected thinking content, sanitizing');
    return sanitizeThinkingContent(content);
  }
  
  return content;
}
