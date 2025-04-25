/**
 * Core state interface for the RAG graph
 */
export interface AgentState {
  // User information
  userId: string;

  // Conversation history
  messages: Message[];

  // Configuration options
  options: {
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
