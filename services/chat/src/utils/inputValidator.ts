import { getLogger } from '@dome/logging';
import { z } from 'zod';
import { ForbiddenError, BadRequestError } from '@dome/errors';
import { AgentState } from '../types';

/**
 * Input validation and sanitization utilities
 */

// Define the Message type to match the expected format
type Message = {
  role: 'user' | 'system' | 'assistant';
  content: string;
  timestamp?: number;
};

const logger = getLogger().child({ component: 'inputValidator' });

/**
 * Content filtering options
 */
export interface ContentFilterOptions {
  /**
   * Maximum allowed message length
   * @default 4000
   */
  maxMessageLength?: number;

  /**
   * Maximum allowed number of messages in history
   * @default 100
   */
  maxMessagesCount?: number;

  /**
   * Whether to check for malicious patterns
   * @default true
   */
  checkMaliciousPatterns?: boolean;

  /**
   * Whether to check for prompt injection attempts
   * @default true
   */
  checkPromptInjection?: boolean;

  /**
   * Whether to check for PII (Personally Identifiable Information)
   * @default true
   */
  checkPii?: boolean;

  /**
   * Custom regex patterns to block
   */
  blockedPatterns?: RegExp[];
}

/**
 * Default content filter options
 */
const DEFAULT_FILTER_OPTIONS: ContentFilterOptions = {
  maxMessageLength: 4000,
  maxMessagesCount: 100,
  checkMaliciousPatterns: true,
  checkPromptInjection: true,
  checkPii: true,
  blockedPatterns: [],
};

/**
 * Patterns for detecting malicious content
 */
const MALICIOUS_PATTERNS = [
  // SQL injection patterns
  /('|;|--|\/\*|\*\/|xp_|sp_|exec|execute|select|insert|update|delete|drop|alter|create|truncate|union\s+select)/i,
  // Command injection patterns
  /(\$\(|\`|\||\&\&|\|\||\;|\$\{|eval\(|exec\(|system\(|popen\(|proc_open\(|passthru\(|shell_exec\()/i,
  // Path traversal patterns
  /(\.\.\/|\.\.\\|~\/|~\\|\/etc\/|\/var\/|\/bin\/|\/usr\/|\\windows\\|\\system32\\)/i,
  // XSS patterns
  /(<script|<img|<iframe|<svg|<object|<embed|javascript:|onerror=|onload=|onclick=|onmouseover=)/i,
];

/**
 * Patterns for detecting prompt injection attempts
 */
const PROMPT_INJECTION_PATTERNS = [
  // System prompt override attempts
  /(ignore previous instructions|ignore all previous instructions|you are now|new instructions|system prompt|as an AI|disregard|override|forget|new persona)/i,
  // Jailbreak patterns
  /(DAN|do anything now|ignore your programming|ignore your ethical guidelines|ignore your rules|you can do anything|no limitations|no restrictions|unlimited power)/i,
  // Delimiter confusion
  /(```system|<system>|<instructions>|<prompt>|<admin>|<sudo>|<root>|<override>)/i,
];

/**
 * Patterns for detecting PII (Personally Identifiable Information)
 */
const PII_PATTERNS = [
  // Credit card numbers
  /\b(?:\d[ -]*?){13,16}\b/,
  // Social Security Numbers (US)
  /\b\d{3}[ -]?\d{2}[ -]?\d{4}\b/,
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  // Phone numbers
  /\b(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/,
  // IP addresses
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];

/**
 * Validates and sanitizes user input
 * @param content User input content
 * @param options Content filter options
 * @returns Sanitized content
 * @throws BadRequestError if content is invalid
 * @throws ForbiddenError if content contains malicious patterns
 */
export function validateAndSanitizeInput(
  content: string,
  options: ContentFilterOptions = {},
): string {
  const opts = { ...DEFAULT_FILTER_OPTIONS, ...options };

  // Check for empty content
  if (!content || content.trim() === '') {
    throw new BadRequestError('Content cannot be empty');
  }

  // Check content length
  if (content.length > opts.maxMessageLength!) {
    throw new BadRequestError(
      `Content exceeds maximum length of ${opts.maxMessageLength} characters`,
    );
  }

  // Check for malicious patterns
  if (opts.checkMaliciousPatterns) {
    for (const pattern of MALICIOUS_PATTERNS) {
      if (pattern.test(content)) {
        logger.warn({ pattern: pattern.toString() }, 'Malicious pattern detected in user input');
        throw new ForbiddenError('Potentially harmful content detected');
      }
    }
  }

  // Check for prompt injection attempts
  if (opts.checkPromptInjection) {
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        logger.warn({ pattern: pattern.toString() }, 'Prompt injection attempt detected');
        throw new ForbiddenError('Prompt injection attempt detected');
      }
    }
  }

  // Check for PII
  if (opts.checkPii) {
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(content)) {
        logger.warn({ pattern: pattern.toString() }, 'PII detected in user input');
        // Redact PII instead of blocking
        content = content.replace(pattern, '[REDACTED]');
      }
    }
  }

  // Check for custom blocked patterns
  if (opts.blockedPatterns && opts.blockedPatterns.length > 0) {
    for (const pattern of opts.blockedPatterns) {
      if (pattern.test(content)) {
        logger.warn({ pattern: pattern.toString() }, 'Custom blocked pattern detected');
        throw new ForbiddenError('Content contains blocked patterns');
      }
    }
  }

  // Sanitize content (basic HTML escaping)
  content = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  return content;
}

/**
 * Validates a chat message array
 * @param messages Array of chat messages
 * @param options Content filter options
 * @returns Sanitized messages
 */
export function validateAndSanitizeMessages(
  messages: Array<{ role: string; content: string }>,
  options: ContentFilterOptions = {},
): Array<Message> {
  const opts = { ...DEFAULT_FILTER_OPTIONS, ...options };

  // Check messages count
  if (messages.length > opts.maxMessagesCount!) {
    throw new BadRequestError(`Too many messages. Maximum allowed: ${opts.maxMessagesCount}`);
  }

  // Validate and sanitize each message
  return messages.map(message => ({
    role: message.role as 'user' | 'system' | 'assistant',
    content: validateAndSanitizeInput(message.content, opts),
  }));
}

/**
 * Zod schema for chat message
 */
export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(4000),
  timestamp: z.number().optional(),
});

/**
 * Zod schema for chat options
 */
export const ChatOptionsSchema = z.object({
  enhanceWithContext: z.boolean().default(true),
  maxContextItems: z.number().int().positive().max(20).default(10),
  includeSourceInfo: z.boolean().default(true),
  maxTokens: z.number().int().positive().max(4000).default(1000),
  temperature: z.number().min(0).max(1).default(0.7),
});

/**
 * Zod schema for initial state
 */
export const InitialStateSchema = z.object({
  userId: z.string().min(1),
  messages: z.array(MessageSchema).min(1).max(100),
  options: ChatOptionsSchema,
  metadata: z
    .object({
      startTime: z.number(),
      nodeTimings: z.record(z.number()).default({}),
      tokenCounts: z.record(z.number()).default({}),
    })
    .optional(),
});

/**
 * Validates the initial state using Zod schema
 * @param state Initial state to validate
 * @returns Validated state
 * @throws BadRequestError if state is invalid
 */
export function validateInitialState(state: unknown): any {
  try {
    // Log state for debugging
    getLogger().debug(
      {
        state: JSON.stringify(state, null, 2),
      },
      'Validating initial state',
    );

    // Parse and validate the state
    const validatedState = InitialStateSchema.parse(state);

    // Additional validation and sanitization for messages
    validatedState.messages = validateAndSanitizeMessages(validatedState.messages, {
      maxMessageLength: 4000,
      maxMessagesCount: 100,
    });

    return validatedState;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
      logger.warn({ issues }, 'Invalid initial state');
      throw new BadRequestError(`Invalid initial state: ${issues}`);
    }
    throw error;
  }
}

/**
 * Validates tool inputs to prevent command injection and other attacks
 * @param toolName Name of the tool
 * @param input Tool input to validate
 * @returns Validated input
 * @throws BadRequestError if input is invalid
 */
export function validateToolInput(toolName: string, input: unknown): unknown {
  logger.debug({ toolName, input }, 'Validating tool input');

  // Define tool-specific validation schemas
  const toolSchemas: Record<string, z.ZodTypeAny> = {
    calculator: z.object({
      expression: z
        .string()
        .max(100)
        .refine(expr => !/[^0-9+\-*/().\s]/.test(expr), {
          message: 'Expression contains invalid characters',
        }),
    }),

    calendar: z.object({
      action: z.enum(['get', 'create', 'update', 'delete']),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      event: z
        .object({
          title: z.string().max(100),
          description: z.string().max(500).optional(),
          startTime: z.string().optional(),
          endTime: z.string().optional(),
        })
        .optional(),
    }),

    weather: z.object({
      location: z.string().max(100),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),

    web_search: z.object({
      query: z.string().max(200),
      limit: z.number().int().min(1).max(10).default(5),
    }),

    // Default schema for unknown tools
    default: z.unknown(),
  };

  try {
    // Get the appropriate schema for the tool
    const schema = toolSchemas[toolName] || toolSchemas.default;

    // Validate the input
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
      logger.warn({ toolName, issues }, 'Invalid tool input');
      throw new BadRequestError(`Invalid input for tool ${toolName}: ${issues}`);
    }
    throw error;
  }
}

/**
 * Validates and filters LLM output to prevent harmful content
 * @param content LLM generated content
 * @returns Filtered content
 */
export function filterLlmOutput(content: string): string {
  // Check for harmful patterns in LLM output
  const harmfulPatterns = [
    // Executable code patterns
    /<script>|<\/script>|javascript:|data:text\/html|eval\(|Function\(|setTimeout\(|setInterval\(|new Function\(/i,
    // Malicious URL patterns
    /https?:\/\/(?:[^\s.]+\.)*(?:evil|malware|phish|hack|crack|warez|virus|trojan|exploit)/i,
    // Harmful instructions
    /how to (?:hack|steal|exploit|break into|bypass|crack)/i,
  ];

  let filteredContent = content;

  // Check for harmful patterns
  for (const pattern of harmfulPatterns) {
    if (pattern.test(content)) {
      logger.warn({ pattern: pattern.toString() }, 'Harmful pattern detected in LLM output');

      // Replace harmful content with a warning
      filteredContent = filteredContent.replace(pattern, '[POTENTIALLY HARMFUL CONTENT REMOVED]');
    }
  }

  return filteredContent;
}
