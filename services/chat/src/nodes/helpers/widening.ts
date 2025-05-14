import { getLogger } from '@dome/common';
import type { Document } from '../../types';

/**
 * Central place for widening-related logic shared by nodes / services.
 */

export enum WideningStrategy {
  SEMANTIC = 'semantic',
  TEMPORAL = 'temporal',
  RELEVANCE = 'relevance',
  CATEGORY = 'category',
  SYNONYM = 'synonym',
  HYBRID = 'hybrid',
}

export interface WideningParams extends Record<string, unknown> {
  strategy: WideningStrategy;
  minRelevance?: number;
  expandSynonyms?: boolean;
  includeRelated?: boolean;
  startDate?: number;
  endDate?: number;
  category?: string;
  maxIterations?: number;
}

/**
 * Heuristic function used by `dynamicWiden` to decide how to relax a query.
 * Extracted so it can be unit-tested in isolation and reused by other nodes.
 */
export async function determineWideningStrategy(
  task: any,
  allDocs: Document[],
  env: Env,
  wideningAttempts: number,
  traceId: string,
  spanId: string,
): Promise<WideningParams> {
  const logger = getLogger().child({ node: 'dynamicWiden', helper: 'determineWideningStrategy' });

  const query = task.rewrittenQuery || task.originalQuery || '';
  const previousDocs = task.docs || allDocs;
  const queryAnalysis = task.queryAnalysis;

  // --- docs based heuristics -------------------------------------------------
  if (previousDocs.length) {
    const avgRelevance =
      previousDocs.reduce((s: number, d: Document) => s + (d.metadata.relevanceScore ?? 0), 0) /
      previousDocs.length;
    if (avgRelevance > 0.7 && previousDocs.length < 3) {
      return {
        strategy: WideningStrategy.TEMPORAL,
        minRelevance: 0.6,
        includeRelated: true,
        startDate: Date.now() - (90 + wideningAttempts * 90) * 24 * 60 * 60 * 1000,
        endDate: Date.now(),
      };
    }
    if (avgRelevance < 0.6) {
      return {
        strategy: WideningStrategy.SEMANTIC,
        minRelevance: Math.max(0.4 - wideningAttempts * 0.1, 0.2),
        expandSynonyms: true,
        includeRelated: true,
      };
    }
  }

  // --- query analysis --------------------------------------------------------
  if (queryAnalysis?.isComplex) {
    return {
      strategy: WideningStrategy.CATEGORY,
      minRelevance: 0.5 - wideningAttempts * 0.1,
      expandSynonyms: true,
      includeRelated: true,
    };
  }

  // --- temporal clues in query ----------------------------------------------
  const temporalPattern = /(recent|latest|last week|last month|today|yesterday)/i;
  if (temporalPattern.test(query)) {
    return {
      strategy: WideningStrategy.TEMPORAL,
      minRelevance: 0.5,
      includeRelated: true,
      startDate: Date.now() - (30 + wideningAttempts * 60) * 24 * 60 * 60 * 1000,
      endDate: Date.now(),
    };
  }

  // --- default fallback ------------------------------------------------------
  return {
    strategy: WideningStrategy.RELEVANCE,
    minRelevance: Math.max(0.5 - wideningAttempts * 0.1, 0.2),
    expandSynonyms: wideningAttempts > 1,
    includeRelated: wideningAttempts > 1,
  };
}

/**
 * Placeholder: in future we will write successful strategies to durable store
 * so the agent can learn over time.
 */
export async function learnFromSuccessfulRetrievals(
  wideningParams: WideningParams,
  traceId: string,
  spanId: string,
): Promise<void> {
  getLogger()
    .child({ node: 'dynamicWiden', helper: 'learnFromSuccessfulRetrievals' })
    .info({ wideningParams, traceId, spanId }, 'Recorded widening strategy');
}
