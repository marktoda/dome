import { z } from 'zod';
import { Annotation } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

export const roleSchema = z.enum(['user', 'assistant', 'system']);

export type ChatTokenStream = AsyncIterable<string>

// Define schemas for request validation
export const chatRequestSchema = z.object({
  stream: z.boolean().optional().default(true),
  userId: z.string(),
  messages: z.array(
    z.object({
      role: roleSchema,
      content: z.string(),
      timestamp: z.number().optional(),
    }),
  ),
  options: z.object({
    enhanceWithContext: z.boolean().optional().default(true),
    maxContextItems: z.number().optional().default(5),
    includeSourceInfo: z.boolean().optional().default(true),
    maxTokens: z.number().optional().default(1000),
    temperature: z.number().optional(),
    modelId: z.string().optional(),
  }),
  runId: z.string().optional(),
});

export const resumeChatRequestSchema = z.object({
  runId: z.string(),
  newMessage: z
    .object({
      role: roleSchema,
      content: z.string(),
      timestamp: z.number().optional(),
    })
    .optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type Role = z.infer<typeof roleSchema>;
export type ResumeChatRequest = z.infer<typeof resumeChatRequestSchema>;

/**
 * Message interface
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

/**
 * Message pair interface for structured chat history
 */
export interface MessagePair {
  user: Message;
  assistant: Message;
  timestamp: number;
  tokenCount?: number;
}

/**
 * User task entity interface for multi-task support
 */
export interface UserTaskEntity {
  id: string;
  definition?: string;
  originalQuery?: string;
  rewrittenQuery?: string;
  requiredTools?: string[];
  toolResults?: ToolResult[];
  needsWidening?: boolean;
  wideningAttempts?: number;
  toolToRun?: string | null;
  queryAnalysis?: QueryAnalysis;
  toolParameters?: Record<string, unknown>;
  toolError?: string;
  wideningStrategy?: string;
  toolSelectionReason?: string;
  toolSelectionConfidence?: number;
  wideningParams?: Record<string, unknown>;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt?: number;
  completedAt?: number;
  docs?: Document[];
  completable?: boolean;
  // Additional fields for compatibility with existing code
  tool?: string;
  toolResult?: { output: any };
  reasonForWidening?: string;
}

/**
 * Core state interface for the RAG graph V2
 */
export interface AgentState {
  // User information
  userId: string;

  // Conversation history
  messages: Message[];
  chatHistory?: MessagePair[];

  // Task information and tracking
  tasks: {
    originalQuery?: string;
    rewrittenQuery?: string;
    requiredTools?: string[];
    toolResults?: ToolResult[];
    needsWidening?: boolean;
    wideningAttempts?: number;
    toolToRun?: string | null;
    queryAnalysis?: QueryAnalysis;
    toolParameters?: Record<string, unknown>;
    toolError?: string;
    wideningStrategy?: string;
    toolSelectionReason?: string;
    toolSelectionConfidence?: number;
    wideningParams?: Record<string, unknown>;
  };
  
  // Multi-task entities
  taskEntities?: Record<string, UserTaskEntity>;

  // Configuration options
  options: {
    enhanceWithContext: boolean;
    maxContextItems: number;
    includeSourceInfo: boolean;
    maxTokens: number;
    temperature?: number;
    modelId?: string;
  };

  // Retrieved documents
  docs?: Document[];

  // Reasoning and instructions
  reasoning?: string[];
  instructions?: string;
  
  // File management
  files?: string;
  
  // Tool tracking
  tool?: string;

  // Generated content
  generatedText?: string;

  // Filters for document retrieval and processing
  _filter?: Record<string, any>;

  // Metadata for tracking and debugging
  metadata: {
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
    route?: string;        // Added for routing control in the graph
  };
}

/**
 * AI message interface (alias for Message for compatibility with LLM service)
 */
export type AIMessage = Message;

/**
 * Document interface for retrieved content with enhanced relevance scoring
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
    confidence?: number;
    semantic_similarity?: number;
    keyword_match?: number;
    recency_boost?: number;
    user_preference_score?: number;
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
  attributes: Record<string, unknown>;
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

/* ------------------------------------------------------------------ */
/*  1.  Helper reducers                                               */
/* ------------------------------------------------------------------ */

export const concat = <T>() =>
  Annotation<T[]>({
    reducer: (prev: T[], next: T[]) => prev.concat(next),
    default: () => [],
  });

export const merge = <T extends object>() =>
  Annotation<T>({
    reducer: (prev: T, next: T) => ({ ...prev, ...next }),
    default: () => ({} as T),
  });

/* ------------------------------------------------------------------ */
/*  2.  Graph-state definition that matches your AgentState           */
/* ------------------------------------------------------------------ */

export const GraphStateAnnotation = Annotation.Root({
  /* ---------- required / scalar ----------------------------------- */
  userId: Annotation<string>(),
  
  /* ---------- conversation history -------------------------------- */
  messages: concat<Message>(),
  chatHistory: Annotation<MessagePair[]>(),
  
  /* ---------- static config --------------------------------------- */
  options: Annotation<AgentState['options']>(),
  
  /* ---------- working area for nodes ------------------------------ */
  tasks: merge<NonNullable<AgentState['tasks']>>(),
  taskEntities: merge<Record<string, UserTaskEntity>>(),
  docs: concat<Document>(),
  reasoning: concat<string>(),
  instructions: Annotation<string>(),
  files: Annotation<string>(),
  generatedText: Annotation<string>(),
  tool: Annotation<string>(),
  
  /* ---------- meta / tracing -------------------------------------- */
  metadata: merge<NonNullable<AgentState['metadata']>>(),
  
  /* ---------- filtering ------------------------------------------- */
  _filter: merge<Record<string, any>>(),
});
