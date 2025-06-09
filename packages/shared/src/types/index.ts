import { z } from 'zod';

// Base document types
export interface Document {
  id: string;
  text: string;
  metadata: DocumentMetadata;
  embedding?: number[];
  score?: number;
}

export interface DocumentMetadata {
  source: DataSource;
  sourceId: string;
  sourceUrl?: string;
  title?: string;
  author?: string;
  createdAt: Date;
  updatedAt: Date;
  orgId: string;
  visibility: 'public' | 'private' | 'internal';
  permissions?: string[];
  tags?: string[];
  // Source-specific metadata
  github?: GitHubMetadata;
  notion?: NotionMetadata;
  slack?: SlackMetadata;
  linear?: LinearMetadata;
}

export type DataSource = 'github' | 'notion' | 'slack' | 'linear';

// Source-specific metadata types
export interface GitHubMetadata {
  repo: string;
  owner: string;
  path?: string;
  sha?: string;
  branch?: string;
  pullRequestNumber?: number;
  issueNumber?: number;
}

export interface NotionMetadata {
  pageId: string;
  databaseId?: string;
  workspaceId: string;
  lastEditedBy?: string;
}

export interface SlackMetadata {
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  threadTs?: string;
  teamId: string;
}

export interface LinearMetadata {
  issueId: string;
  projectId: string;
  teamId: string;
  state?: string;
  priority?: number;
  assigneeId?: string;
}

// Chunk types
export interface Chunk {
  id: string;
  documentId: string;
  text: string;
  startIndex: number;
  endIndex: number;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata extends DocumentMetadata {
  chunkIndex: number;
  totalChunks: number;
  overlapWithPrevious?: number;
  overlapWithNext?: number;
}

// Event types for Kafka
export const KafkaEventSchema = z.object({
  id: z.string(),
  source: z.enum(['github', 'notion', 'slack', 'linear']),
  type: z.string(),
  timestamp: z.string().datetime(),
  orgId: z.string(),
  payload: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
});

export type KafkaEvent = z.infer<typeof KafkaEventSchema>;

// Query types
export interface QueryRequest {
  question: string;
  filters?: QueryFilters;
  options?: QueryOptions;
}

export interface QueryFilters {
  sources?: DataSource[];
  orgId?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  topK?: number;
  temperature?: number;
  includeMetadata?: boolean;
  includeSources?: boolean;
  stream?: boolean;
}

export interface QueryResponse {
  answer: string;
  sources?: Document[];
  confidence?: number;
  metadata?: {
    totalTokens?: number;
    latencyMs?: number;
    model?: string;
  };
}

// Agent types
export interface AgentState {
  question: string;
  context: Document[];
  history: AgentMessage[];
  currentStep: string;
  metadata: Record<string, unknown>;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

// Error types
export class Dome2Error extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'Dome2Error';
  }
}

export class ValidationError extends Dome2Error {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Dome2Error {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends Dome2Error {
  constructor(message: string, details?: unknown) {
    super(message, 'UNAUTHORIZED', 401, details);
    this.name = 'UnauthorizedError';
  }
}

export class RateLimitError extends Dome2Error {
  constructor(message: string, details?: unknown) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429, details);
    this.name = 'RateLimitError';
  }
}

// Connector interface
export interface Connector<T = unknown> {
  name: string;
  initialize(): Promise<void>;
  handle(event: T): Promise<void>;
  shutdown(): Promise<void>;
}

// Vector store interface
export interface VectorStore {
  name: string;
  initialize(): Promise<void>;
  upsert(documents: Document[]): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<Document[]>;
  delete(ids: string[]): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SearchOptions {
  topK?: number;
  filter?: Record<string, unknown>;
  includeMetadata?: boolean;
  hybridSearch?: boolean;
  alpha?: number; // For hybrid search weighting
}
