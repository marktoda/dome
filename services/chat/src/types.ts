import { z } from 'zod';

// Define schemas for request validation
export const chatRequestSchema = z.object({
  stream: z.boolean().optional().default(true),
  initialState: z.object({
    userId: z.string(),
    messages: z.array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
        timestamp: z.number().optional(),
      }),
    ),
    enhanceWithContext: z.boolean().optional().default(true),
    maxContextItems: z.number().optional().default(5),
    includeSourceInfo: z.boolean().optional().default(true),
    maxTokens: z.number().optional().default(1000),
    temperature: z.number().optional(),
  }),
  runId: z.string().optional(),
});

export const resumeChatRequestSchema = z.object({
  runId: z.string(),
  newMessage: z
    .object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      timestamp: z.number().optional(),
    })
    .optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ResumeChatRequest = z.infer<typeof resumeChatRequestSchema>;

/**
 * Core state interface for the RAG graph
 */
export interface AgentState {
  // The initial state - moved properties from the top level to match actual structure
  initialState?: {
    // User information
    userId: string;

    // Conversation history
    messages: Message[];

    // Configuration options
    options?: {
      enhanceWithContext: boolean;
      maxContextItems: number;
      includeSourceInfo: boolean;
      maxTokens: number;
      temperature?: number;
    };
  };

  // Conversation history - kept for backward compatibility
  messages: Message[];

  // Configuration options - kept for backward compatibility
  options?: {
    enhanceWithContext: boolean;
    maxContextItems: number;
    includeSourceInfo: boolean;
    maxTokens: number;
    temperature?: number;
  };

  // Intermediate processing data
  tasks?: {
    originalQuery?: string;
    rewrittenQuery?: string;
    requiredTools?: string[];
    toolResults?: ToolResult[];
    needsWidening?: boolean;
    wideningAttempts?: number;
    toolToRun?: string | null;
    queryAnalysis?: QueryAnalysis;
    toolParameters?: Record<string, any>;
    toolError?: string;
    wideningStrategy?: string;
    toolSelectionReason?: string;
    toolSelectionConfidence?: number;
    wideningParams?: Record<string, any>;
  };

  // Retrieved documents
  docs?: Document[];

  // Generated content
  generatedText?: string;

  // Metadata for tracking and debugging
  metadata?: {
    startTime?: number;
    nodeTimings?: Record<string, number>;
    tokenCounts?: Record<string, number>;
    currentNode?: string;
    isFinalState?: boolean;
    errors?: Array<{
      node: string;
      message: string;
      timestamp: number;
    }>;
    traceId?: string;
    spanId?: string;
    executionTimeMs?: number;
  };
}

/**
 * Message interface
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

/**
 * AI message interface (alias for Message for compatibility with LLM service)
 */
export type AIMessage = Message;

/**
 * Document interface for retrieved content
 */
export interface Document {
  id: string;
  title: string;
  body: string;
  metadata: {
    source: string;
    createdAt: string;
    relevanceScore: number;
    tokenCount?: number;
    url?: string | null;
    mimeType?: string;
  };
}

/**
 * Tool result interface
 */
export interface ToolResult {
  toolName: string;
  input: unknown;
  output: unknown;
  error?: string;
  executionTimeMs?: number;
}

/**
 * Query analysis interface
 */
export interface QueryAnalysis {
  isComplex: boolean;
  shouldSplit: boolean;
  reason: string;
  suggestedQueries?: string[];
}

/**
 * Source metadata interface for attribution
 */
export interface SourceMetadata {
  id: string;
  title: string;
  source: string;
  url?: string | null;
  relevanceScore: number;
}

/**
 * Trace event interface for observability
 */
export interface TraceEvent {
  traceId: string;
  spanId: string;
  name: string;
  timestamp: number;
  duration?: number;
  attributes: Record<string, any>;
}

/**
 * LLM call metrics interface
 */
export interface LlmCallMetrics {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  executionTimeMs: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Retrieval metrics interface
 */
export interface RetrievalMetrics {
  query: string;
  resultCount: number;
  executionTimeMs: number;
  topRelevanceScore?: number;
  avgRelevanceScore?: number;
  wideningAttempts?: number;
}
