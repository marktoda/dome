import { TRPCError } from '@trpc/server';

import { generateId } from '@dome2/shared/utils';

import { protectedProcedure, publicProcedure, router } from './init.js';
import {
  queryAskSchema,
  querySearchSchema,
  agentQuerySchema,
  queryResponseSchema,
  searchResponseSchema,
  agentResponseSchema,
  healthResponseSchema,
  statsResponseSchema,
  githubWebhookSchema,
  notionWebhookSchema,
  linearWebhookSchema,
} from './schemas.js';

// Query router
const queryRouter = router({
  ask: protectedProcedure
    .input(queryAskSchema)
    .output(queryResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { question, orgId, filters, options } = input;
      const queryId = generateId('query');

      ctx.logger.info('RAG query request', {
        queryId,
        orgId,
        question: question.substring(0, 100),
        filters,
        options,
      });

      // TODO: Implement actual RAG pipeline integration
      // For now, return a mock response
      return {
        answer: `Mock answer for: "${question}"`,
        sources: [],
        confidence: 0.8,
        metadata: {
          queryId,
          totalTokens: 150,
          latencyMs: 500,
          model: 'gpt-4o-mini',
        },
      };
    }),

  search: protectedProcedure
    .input(querySearchSchema)
    .output(searchResponseSchema)
    .query(async ({ input, ctx }) => {
      const { query, orgId, filters, topK } = input;
      const queryId = generateId('search');

      ctx.logger.info('Vector search request', {
        queryId,
        orgId,
        query: query.substring(0, 100),
        filters,
        topK,
      });

      // TODO: Implement actual vector search
      return {
        results: [],
        metadata: {
          total: 0,
          latencyMs: 100,
          queryId,
        },
      };
    }),

  askAgent: protectedProcedure
    .input(agentQuerySchema)
    .output(agentResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { question, orgId, context, tools, stream } = input;
      const conversationId = context?.conversationId || generateId('conv');

      ctx.logger.info('Agent query request', {
        conversationId,
        orgId,
        question: question.substring(0, 100),
        tools,
        stream,
      });

      // TODO: Implement actual LangGraph agent integration
      return {
        messages: [
          {
            role: 'user' as const,
            content: question,
            timestamp: new Date().toISOString(),
          },
          {
            role: 'assistant' as const,
            content: `Mock agent response for: "${question}"`,
            timestamp: new Date().toISOString(),
          },
        ],
        finalAnswer: `Mock agent response for: "${question}"`,
        metadata: {
          conversationId,
          totalTokens: 200,
          latencyMs: 1500,
          stepsCount: 3,
        },
      };
    }),
});

// System router
const systemRouter = router({
  health: publicProcedure.output(healthResponseSchema).query(async ({ ctx }) => {
    // TODO: Implement actual health checks
    return {
      status: 'healthy' as const,
      timestamp: new Date().toISOString(),
      services: {
        database: 'healthy' as const,
        vectorStore: 'healthy' as const,
        kafka: 'healthy' as const,
        redis: 'healthy' as const,
      },
      uptime: process.uptime(),
      version: '1.0.0',
    };
  }),

  stats: protectedProcedure.output(statsResponseSchema).query(async ({ ctx }) => {
    // TODO: Implement actual metrics collection
    return {
      metrics: {
        totalQueries: 0,
        totalDocuments: 0,
        avgLatency: 0,
        errorRate: 0,
      },
      timestamp: new Date().toISOString(),
    };
  }),
});

// Webhook router
const webhooksRouter = router({
  github: publicProcedure.input(githubWebhookSchema).mutation(async ({ input, ctx }) => {
    const { headers, body, signature: _signature } = input;

    ctx.logger.info('GitHub webhook received', {
      headers: Object.keys(headers),
      bodyType: typeof body,
    });

    // TODO: Implement GitHub webhook verification and processing
    // For now, just acknowledge receipt
    return { success: true };
  }),

  notion: publicProcedure.input(notionWebhookSchema).mutation(async ({ input, ctx: _ctx }) => {
    const { headers, body } = input;

    _ctx.logger.info('Notion webhook received', {
      headers: Object.keys(headers),
      bodyType: typeof body,
    });

    // TODO: Implement Notion webhook processing
    return { success: true };
  }),

  linear: publicProcedure.input(linearWebhookSchema).mutation(async ({ input, ctx }) => {
    const { headers, body, signature: _signature } = input;

    ctx.logger.info('Linear webhook received', {
      headers: Object.keys(headers),
      bodyType: typeof body,
    });

    // TODO: Implement Linear webhook verification and processing
    return { success: true };
  }),
});

// Main app router
export const appRouter = router({
  query: queryRouter,
  system: systemRouter,
  webhooks: webhooksRouter,
});

export type AppRouter = typeof appRouter;
