import { z } from 'zod';

// Common schemas
export const orgIdSchema = z.string().uuid();
export const paginationSchema = z.object({
  limit: z.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// Query schemas
export const queryAskSchema = z.object({
  question: z.string().min(1).max(1000),
  orgId: orgIdSchema,
  filters: z
    .object({
      sources: z.array(z.enum(['github', 'notion', 'slack', 'linear'])).optional(),
      dateRange: z
        .object({
          start: z.string().datetime(),
          end: z.string().datetime(),
        })
        .optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  options: z
    .object({
      topK: z.number().min(1).max(50).default(10),
      temperature: z.number().min(0).max(2).default(0.7),
      includeMetadata: z.boolean().default(true),
      includeSources: z.boolean().default(true),
      stream: z.boolean().default(false),
    })
    .optional(),
});

export const querySearchSchema = z.object({
  query: z.string().min(1).max(500),
  orgId: orgIdSchema,
  filters: z
    .object({
      sources: z.array(z.enum(['github', 'notion', 'slack', 'linear'])).optional(),
      dateRange: z
        .object({
          start: z.string().datetime(),
          end: z.string().datetime(),
        })
        .optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  topK: z.number().min(1).max(50).default(10),
});

export const agentQuerySchema = z.object({
  question: z.string().min(1).max(1000),
  orgId: orgIdSchema,
  context: z
    .object({
      conversationId: z.string().optional(),
      userId: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
  tools: z.array(z.enum(['rag', 'github', 'linear'])).default(['rag']),
  stream: z.boolean().default(true),
});

// Response schemas
export const documentSchema = z.object({
  id: z.string(),
  text: z.string(),
  score: z.number().optional(),
  metadata: z.object({
    source: z.enum(['github', 'notion', 'slack', 'linear']),
    sourceId: z.string(),
    sourceUrl: z.string().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    orgId: z.string(),
    visibility: z.enum(['public', 'private', 'internal']),
    tags: z.array(z.string()).optional(),
  }),
});

export const queryResponseSchema = z.object({
  answer: z.string(),
  sources: z.array(documentSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.object({
    totalTokens: z.number().optional(),
    latencyMs: z.number().optional(),
    model: z.string().optional(),
    queryId: z.string(),
  }),
});

export const searchResponseSchema = z.object({
  results: z.array(documentSchema),
  metadata: z.object({
    total: z.number(),
    latencyMs: z.number(),
    queryId: z.string(),
  }),
});

// Agent response schemas
export const agentMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.unknown()),
        result: z.unknown().optional(),
      })
    )
    .optional(),
  timestamp: z.string().datetime(),
});

export const agentResponseSchema = z.object({
  messages: z.array(agentMessageSchema),
  finalAnswer: z.string().optional(),
  metadata: z.object({
    conversationId: z.string(),
    totalTokens: z.number().optional(),
    latencyMs: z.number(),
    stepsCount: z.number(),
  }),
});

// System schemas
export const healthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  timestamp: z.string().datetime(),
  services: z.object({
    database: z.enum(['healthy', 'unhealthy']),
    vectorStore: z.enum(['healthy', 'unhealthy']),
    kafka: z.enum(['healthy', 'unhealthy']),
    redis: z.enum(['healthy', 'unhealthy']),
  }),
  uptime: z.number(),
  version: z.string(),
});

export const statsResponseSchema = z.object({
  metrics: z.object({
    totalQueries: z.number(),
    totalDocuments: z.number(),
    avgLatency: z.number(),
    errorRate: z.number(),
  }),
  timestamp: z.string().datetime(),
});

// Webhook schemas
export const githubWebhookSchema = z.object({
  headers: z.record(z.string()),
  body: z.unknown(),
  signature: z.string(),
});

export const notionWebhookSchema = z.object({
  headers: z.record(z.string()),
  body: z.unknown(),
});

export const linearWebhookSchema = z.object({
  headers: z.record(z.string()),
  body: z.unknown(),
  signature: z.string(),
});
