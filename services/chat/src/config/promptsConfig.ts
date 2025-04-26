/**
 * Prompts Configuration
 *
 * This file defines system prompts used throughout the chat service.
 * Centralizing prompts allows for easier updates and versioning.
 *
 * @module config/promptsConfig
 */

/**
 * Configuration for system prompts
 */
export interface PromptsConfig {
  /**
   * Prompts for query rewriting
   */
  queryRewriting: {
    /**
     * System prompt for query rewriting
     */
    systemPrompt: string;
  };

  /**
   * Prompts for query complexity analysis
   */
  queryComplexityAnalysis: {
    /**
     * System prompt for analyzing query complexity
     */
    systemPrompt: string;
  };

  /**
   * Prompts for response generation
   */
  responseGeneration: {
    /**
     * Base system prompt for response generation
     */
    baseSystemPrompt: string;

    /**
     * Additional instruction for including source information
     */
    sourceInfoInstruction: string;
  };
}

/**
 * Environment-specific configurations
 */
const ENVIRONMENT_CONFIGS: Record<string, Partial<PromptsConfig>> = {
  development: {
    // Development environment can have more verbose prompts for debugging
  },

  production: {
    // Production uses the default settings
  },

  test: {
    // Test environment can have simplified prompts
    queryRewriting: {
      systemPrompt: `Rewrite the query to make it more effective for retrieval.`,
    },
    queryComplexityAnalysis: {
      systemPrompt: `Analyze if this query is complex and should be split.`,
    },
    responseGeneration: {
      baseSystemPrompt: `You are an AI assistant. Provide a helpful response.`,
      sourceInfoInstruction: `Include source information when available.`,
    },
  },
};

/**
 * Default configuration for system prompts
 */
export const DEFAULT_PROMPTS_CONFIG: PromptsConfig = {
  queryRewriting: {
    systemPrompt: `You are an AI assistant that helps improve search queries.
Your task is to analyze the user's query and rewrite it to make it more effective for retrieval.

If the query contains multiple questions, focus on the main question or split it into separate queries.
If the query contains ambiguous references (like "it", "this", "that"), replace them with specific entities from the conversation context.
If the query is already clear and specific, you can keep it as is.

Respond ONLY with the rewritten query, without any explanations or additional text.`,
  },

  queryComplexityAnalysis: {
    systemPrompt: `You are an AI assistant that analyzes search queries.
Your task is to determine if a query is complex and should be split into multiple simpler queries.

A query might be complex if:
1. It contains multiple distinct questions
2. It asks for comparisons between multiple topics
3. It requests information across different domains or categories
4. It contains too many constraints or conditions

Respond with a JSON object with the following properties:
- isComplex: boolean indicating if the query is complex
- shouldSplit: boolean indicating if the query should be split
- reason: brief explanation of your decision
- suggestedQueries: array of simpler queries if shouldSplit is true (max 3)`,
  },

  responseGeneration: {
    baseSystemPrompt: `You are an AI assistant with access to the user's personal knowledge base.`,
    sourceInfoInstruction:
      'When referencing information from these documents, include the document number in brackets, e.g., [1], to help the user identify the source.\n\n',
  },
};

/**
 * Get the current environment
 * @returns The current environment name
 */
function getCurrentEnvironment(): string {
  // Check for environment variables that might indicate the environment
  // Default to 'development' if not specified
  return process.env.NODE_ENV || 'development';
}

/**
 * Get the prompts configuration for the current environment
 * @returns The environment-specific prompts configuration
 */
export function getPromptsConfig(): PromptsConfig {
  const environment = getCurrentEnvironment();
  const envConfig = ENVIRONMENT_CONFIGS[environment] || {};

  // Deep merge the environment config with the default config
  return {
    queryRewriting: {
      ...DEFAULT_PROMPTS_CONFIG.queryRewriting,
      ...(envConfig.queryRewriting || {}),
    },
    queryComplexityAnalysis: {
      ...DEFAULT_PROMPTS_CONFIG.queryComplexityAnalysis,
      ...(envConfig.queryComplexityAnalysis || {}),
    },
    responseGeneration: {
      ...DEFAULT_PROMPTS_CONFIG.responseGeneration,
      ...(envConfig.responseGeneration || {}),
    },
  };
}

/**
 * Get the system prompt for query rewriting
 * @returns The system prompt for query rewriting
 */
export function getQueryRewritingPrompt(): string {
  return getPromptsConfig().queryRewriting.systemPrompt;
}

/**
 * Get the system prompt for query complexity analysis
 * @returns The system prompt for query complexity analysis
 */
export function getQueryComplexityAnalysisPrompt(): string {
  return getPromptsConfig().queryComplexityAnalysis.systemPrompt;
}

/**
 * Get the system prompt for response generation
 * @param context The context to include in the prompt
 * @param includeSourceInfo Whether to include source information instructions
 * @returns The system prompt for response generation
 */
export function getResponseGenerationPrompt(
  context: string = '',
  includeSourceInfo: boolean = false,
): string {
  const config = getPromptsConfig();

  let prompt = config.responseGeneration.baseSystemPrompt;

  if (context) {
    prompt += `\nHere is relevant information from the user's knowledge base that may help with the response:\n\n${context}\n\n`;
  }

  if (includeSourceInfo) {
    prompt += config.responseGeneration.sourceInfoInstruction;
  }

  prompt +=
    '\nProvide a helpful, accurate, and concise response based on the provided context and your knowledge.';

  return prompt;
}
