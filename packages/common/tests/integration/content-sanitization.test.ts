import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  createContentSanitizer, 
  sanitizeThinkingContent, 
  createPatternDetector, 
  isThinkingContent,
  processThinkingContent
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

describe('Content Sanitization Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Edge Cases', () => {
    it('should handle extremely long content', () => {
      // Create a very long string
      const longString = 'a'.repeat(100000);
      
      // Sanitize it
      const result = sanitizeThinkingContent(longString);
      
      // Should complete without errors and return a string
      expect(typeof result).toBe('string');
    });

    it('should handle content with unusual Unicode characters', () => {
      const unicodeString = '😀 Unicode test 🚀 with emojis 🔥 and special chars: ™ © ® ¥ £ € ¢';
      
      const result = sanitizeThinkingContent(unicodeString);
      
      // Should preserve most Unicode characters while removing problematic ones
      expect(result).toContain('Unicode test');
      expect(result).toContain('with emojis');
      expect(result).toContain('and special chars');
    });

    it('should handle content with HTML and script tags', () => {
      const htmlContent = '<script>alert("XSS")</script><img src="x" onerror="alert(\'XSS\')">';
      
      const result = sanitizeThinkingContent(htmlContent);
      
      // Should neutralize script tags
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
    });

    it('should handle content with SQL injection attempts', () => {
      const sqlInjection = "'; DROP TABLE users; --";
      
      const result = sanitizeThinkingContent(sqlInjection);
      
      // Should sanitize SQL injection characters
      expect(result).not.toBe(sqlInjection);
      expect(result).not.toContain("';");
    });
  });

  describe('Pattern Detection', () => {
    it('should correctly identify thinking patterns in mixed content', () => {
      const mixedContent = [
        "Here's a normal response.",
        "<thinking>Let me analyze this problem step by step.</thinking>",
        "The answer is 42.",
        "Let me think about this problem carefully.",
        "First, we need to understand the requirements.",
        "The solution is simple."
      ].join('\n');
      
      // Split by lines and test each line
      const lines = mixedContent.split('\n');
      
      expect(isThinkingContent(lines[0])).toBe(false);
      expect(isThinkingContent(lines[1])).toBe(true);
      expect(isThinkingContent(lines[2])).toBe(false);
      expect(isThinkingContent(lines[3])).toBe(true);
      expect(isThinkingContent(lines[4])).toBe(true);
      expect(isThinkingContent(lines[5])).toBe(false);
    });

    it('should detect thinking content in various formats', () => {
      const thinkingFormats = [
        "<thinking>Internal thought process</thinking>",
        "Let me think about this problem",
        "I'm thinking about the solution",
        "Analyzing the data provided",
        "Let's analyze this step by step",
        "Let's think step by step",
        "Step 1: Understand the problem",
        "First, we need to identify the variables",
        "To start, let's break down the requirements"
      ];
      
      thinkingFormats.forEach(format => {
        expect(isThinkingContent(format)).toBe(true);
      });
    });
  });

  describe('Sanitization Pipeline', () => {
    it('should process content through the complete pipeline', () => {
      // Create a custom sanitizer for testing
      const customSanitizer = createContentSanitizer({
        replacementPatterns: [
          { pattern: /secret-\d+/g, replacement: '[REDACTED]' },
        ],
        neutralizationPatterns: [
          { pattern: /\s+/g, replacement: ' ' },
        ],
      });
      
      // Create a custom detector
      const isSecretContent = createPatternDetector({
        patterns: [/secret/i, /confidential/i, /private/i],
      });
      
      // Create a processing pipeline similar to processThinkingContent
      const processContent = (content: string): string => {
        if (!content) return '';
        
        if (isSecretContent(content)) {
          return customSanitizer(content);
        }
        
        return content;
      };
      
      // Test various inputs
      const testCases = [
        {
          input: 'This is normal content',
          expected: 'This is normal content',
        },
        {
          input: 'This contains secret-123 information',
          expected: 'This contains [REDACTED] information',
        },
        {
          input: 'Confidential:    multiple    spaces',
          expected: 'Confidential: multiple spaces',
        },
      ];
      
      testCases.forEach(({ input, expected }) => {
        expect(processContent(input)).toBe(expected);
      });
    });

    it('should handle real-world thinking content examples', () => {
      const realWorldExamples = [
        `<thinking>
        Let me analyze this problem:
        1. First, I need to understand the requirements
        2. Then, I'll identify the key variables
        3. Finally, I'll formulate a solution
        </thinking>`,
        
        `Let me think step by step about how to solve this equation:
        x^2 + 5x + 6 = 0
        First, I'll try to factor this.
        (x + 2)(x + 3) = 0
        So x = -2 or x = -3`,
        
        `Analyzing the data provided:
        - User growth: 20% YoY
        - Revenue: $1.2M
        - Costs: $800K
        This gives us a profit margin of about 33%`
      ];
      
      realWorldExamples.forEach(example => {
        // Should detect as thinking content
        expect(isThinkingContent(example)).toBe(true);
        
        // Should sanitize appropriately
        const sanitized = processThinkingContent(example);
        
        // Core content should be preserved
        expect(sanitized).toContain('analyze');
        expect(sanitized).toContain('step by step');
        expect(sanitized).toContain('Analyzing');
        
        // Should not contain any problematic patterns
        expect(sanitized).not.toMatch(/[^\w\s.,;:'"(){}\[\]<>?!@#$%^&*\-+=|\\\/]+/g);
      });
    });
  });
});