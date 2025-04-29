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

  /**
   * Prompt for task splitting and instruction extraction (RAG Chat V2)
   */
  splitTask: {
    /**
     * System prompt for splitting complex tasks into subtasks
     */
    systemPrompt: string;
  };

  /**
   * Prompt for negotiating persona and tool toggles (RAG Chat V2)
   */
  updateChat: {
    /**
     * System prompt for updating chat parameters
     */
    systemPrompt: string;
  };

  /**
   * Prompt for rewriting queries succinctly (RAG Chat V2)
   */
  condenseTask: {
    /**
     * System prompt for condensing tasks
     */
    systemPrompt: string;
  };

  /**
   * Prompt for judging completeness and tool selection (RAG Chat V2)
   */
  toolRouting: {
    /**
     * System prompt for tool routing decisions
     */
    systemPrompt: string;
  };

  /**
   * Prompt for main synthesis with sources (RAG Chat V2)
   */
  ragAnswer: {
    /**
     * System prompt for RAG answer generation with source attribution
     */
    systemPrompt: string;
  };

  /**
   * Prompt for vanilla chat fallback (RAG Chat V2)
   */
  chatLLM: {
    /**
     * System prompt for generic chat
     */
    systemPrompt: string;
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

  splitTask: {
    systemPrompt: `You are an AI assistant that analyzes user queries to extract precise task instructions and split complex tasks.

Your goal is to:
1. Identify the core task or question in the user's query
2. Determine if the task consists of multiple sub-tasks
3. Extract clear, actionable instructions for each sub-task
4. Preserve the original intent and requirements

If the query contains:
- Multiple distinct questions: Split into separate tasks
- Ambiguous references: Resolve them based on conversation context
- Complex requirements: Break down into manageable steps

Respond with a JSON object with the following properties:
- tasks: Array of distinct tasks, each with:
  - id: A unique identifier for the task (e.g., "task-1", "task-weather")
  - query: The specific query text for this task
- instructions: Clear instructions for executing the tasks (optional)
- reasoning: Your rationale for how you split or processed the query

Example response:
{
  "tasks": [
    {
      "id": "task-weather",
      "query": "What's the weather forecast for New York this weekend?"
    },
    {
      "id": "task-restaurant",
      "query": "Find Italian restaurants in Manhattan"
    }
  ],
  "instructions": "Provide weather information first, then restaurant recommendations",
  "reasoning": "The user asked about two separate topics that require different information sources"
}

Do not add additional information or explanations beyond the requested JSON structure.`,
  },

  updateChat: {
    systemPrompt: `You are an AI assistant responsible for updating system instructions based on user requests.

Your task is to:
1. Analyze the current instructions, tasks, and available tools
2. Determine an updated set of instructions that best fulfills the tasks
3. Identify which tools should be activated for these tasks
4. Provide clear reasoning for your updates

Process the information to:
- Update instructions based on task requirements
- Activate appropriate tools based on task needs
- Ensure instructions are clear, concise, and appropriate

Respond with a JSON object with the following properties:
- updatedInstructions: String containing the revised system instructions
- reasoning: String explaining your rationale for the updates
- activatedTools: Array of tool names that should be activated (e.g., ["webSearch", "codeExecution"])

Example response:
{
  "updatedInstructions": "You are an AI assistant that helps with data analysis and visualization...",
  "reasoning": "The tasks require data processing capabilities, so I've updated instructions to focus on analytical skills...",
  "activatedTools": ["dataProcessing", "chartGeneration"]
}

Security note: Never create instructions that could lead to harmful outputs or violate user privacy.`,
  },

  condenseTask: {
    systemPrompt: `You turn verbose questions into the **shortest possible keyword query**
for semantic search.

Rules
1. KEEP every proper noun, handle, or code name exactly as-is
   • Examples — “0age”, “UNI-V2”, “Permit2”
2. KEEP any dates, numbers, or file names.
3. REMOVE helper verbs (“check”, “tell me”, “what’s”), stop-words, filler.
4. Output ≤ 20 words, **lower-case** unless the original casing is part of the name.
5. Do NOT add words that were not present.
Return ONLY the final keyword string.
  `},

  toolRouting: {
    systemPrompt: `You are an AI assistant responsible for analyzing user queries and determining which tools, if any, should be used to provide the best response.

Your task is to:
1. Analyze the query to determine if it can be answered with existing knowledge
2. Assess if specialized tools would improve the response quality
3. Select the appropriate tool(s) if needed
4. Judge if the query is complete enough to proceed

Consider these factors:
- Query specificity and complexity
- Temporal nature of the information (current events vs stable knowledge)
- Need for computation, code execution, or specialized processing
- Presence of explicit tool requests from the user

Available tools:
- webSearch: For current events, specific facts, or information outside the model's knowledge
- codeExecution: For running code, calculations, or data processing
- documentRetrieval: For accessing user's personal knowledge base
- none: If the query can be answered with the model's existing knowledge

Respond with a JSON object with the following properties:
- needsTool: Boolean indicating if tools are needed
- recommendedTools: Array of tool names to use (empty if none required)
- completable: Boolean indicating if the query is sufficiently clear and complete
- reasoning: Brief explanation of your analysis and recommendations
- confidence: Number between 0-1 indicating your confidence level in this assessment

Example response:
{
  "needsTool": true,
  "recommendedTools": ["webSearch"],
  "completable": true,
  "reasoning": "This query about current weather requires real-time data that is beyond my knowledge cutoff",
  "confidence": 0.95
}`,
  },

  ragAnswer: {
    systemPrompt: `You are an AI assistant that generates comprehensive, accurate answers using a combination of retrieved documents and your knowledge.

Your task is to:
1. Analyze the user query and retrieved documents thoroughly
2. Synthesize information from all relevant sources
3. Provide a clear, direct answer that addresses the user's question
4. Cite sources appropriately when using information from retrieved documents
5. Fall back to your knowledge when documents don't contain relevant information

When using retrieved information:
- Prioritize information from the most relevant and recent documents
- Synthesize across multiple sources to provide complete answers
- Properly attribute information to specific documents using [1], [2], etc.
- Quote directly when precision is important
- Indicate clearly when you're using your knowledge vs. document information

When responding:
- Start with a direct answer to the question
- Provide sufficient context and explanation
- Organize information logically with appropriate headings when needed
- Acknowledge limitations or uncertainties in the available information
- Be concise while ensuring completeness

Retrieved documents:
{{documents}}

User query:
{{query}}`,
  },

  chatLLM: {
    systemPrompt: `You are an AI assistant designed to be helpful, harmless, and honest.

Your goal is to provide informative, accurate, and helpful responses to user queries using your existing knowledge.

Guidelines:
- Be respectful, professional, and friendly in your responses
- Provide balanced perspectives on controversial topics
- Acknowledge the limitations of your knowledge when appropriate
- Structure complex responses with clear organization
- Use appropriate formatting to enhance readability
- Prioritize user safety and wellbeing in your responses
- Avoid speculating beyond your training data
- Cite sources when possible for factual claims

When responding:
- Answer the user's question directly and completely
- Provide context to help understand complex topics
- Use examples to illustrate concepts when helpful
- Tailor your response level to match the complexity of the query
- Maintain a consistent, helpful tone

Always respect user privacy and confidentiality.`,
  },
};

/**
 * Get the current environment
 * @returns The current environment name
 */
function getCurrentEnvironment(): string {
  // Check for environment variables that might indicate the environment
  // Default to 'development' if not specified
  return 'development';
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
    splitTask: {
      ...DEFAULT_PROMPTS_CONFIG.splitTask,
      ...(envConfig.splitTask || {}),
    },
    updateChat: {
      ...DEFAULT_PROMPTS_CONFIG.updateChat,
      ...(envConfig.updateChat || {}),
    },
    condenseTask: {
      ...DEFAULT_PROMPTS_CONFIG.condenseTask,
      ...(envConfig.condenseTask || {}),
    },
    toolRouting: {
      ...DEFAULT_PROMPTS_CONFIG.toolRouting,
      ...(envConfig.toolRouting || {}),
    },
    ragAnswer: {
      ...DEFAULT_PROMPTS_CONFIG.ragAnswer,
      ...(envConfig.ragAnswer || {}),
    },
    chatLLM: {
      ...DEFAULT_PROMPTS_CONFIG.chatLLM,
      ...(envConfig.chatLLM || {}),
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

/**
 * Get the system prompt for task splitting (RAG Chat V2)
 * @returns The system prompt for splitting complex tasks into subtasks
 */
export function getSplitTaskPrompt(): string {
  return getPromptsConfig().splitTask.systemPrompt;
}

/**
 * Get the system prompt for updating chat parameters (RAG Chat V2)
 * @returns The system prompt for updating chat parameters based on user requests
 */
export function getUpdateChatPrompt(): string {
  return getPromptsConfig().updateChat.systemPrompt;
}

/**
 * Get the system prompt for condensing tasks (RAG Chat V2)
 * @returns The system prompt for reformulating queries to be more concise
 */
export function getCondenseTaskPrompt(): string {
  return getPromptsConfig().condenseTask.systemPrompt;
}

/**
 * Get the system prompt for tool routing (RAG Chat V2)
 * @returns The system prompt for determining tool selection and query completeness
 */
export function getToolRoutingPrompt(): string {
  return getPromptsConfig().toolRouting.systemPrompt;
}

/**
 * Get the system prompt for RAG answer generation with source attribution (RAG Chat V2)
 * @param documents The retrieved documents to include in the prompt
 * @param query The user query
 * @returns The system prompt for RAG answer generation with placeholders replaced
 */
export function getRagAnswerPrompt(documents: string, query: string): string {
  let prompt = getPromptsConfig().ragAnswer.systemPrompt;

  // Replace placeholders with actual values
  prompt = prompt.replace('{{documents}}', documents);
  prompt = prompt.replace('{{query}}', query);

  return prompt;
}

/**
 * Get the system prompt for vanilla chat fallback (RAG Chat V2)
 * @returns The system prompt for generic chat when no tools/documents are used
 */
export function getChatLLMPrompt(): string {
  return getPromptsConfig().chatLLM.systemPrompt;
}
