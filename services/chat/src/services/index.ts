import { getLogger } from '@dome/common';
import { LlmService } from './llmService';
import { SearchService } from './searchService';
import { ObservabilityService } from './observabilityService';
import { ModelFactory } from './modelFactory';
import { D1Checkpointer } from '../checkpointer/d1Checkpointer';
import { DataRetentionManager } from '../utils/dataRetentionManager';

/**
 * Service container interface
 */
export interface Services {
  llm: LlmService;
  search: SearchService;
  observability: ObservabilityService;
  modelFactory: typeof ModelFactory;
  checkpointer: D1Checkpointer;
  dataRetention: DataRetentionManager;
}

/**
 * Create and initialize all services
 * @param env Environment bindings
 * @returns Services container
 */
export function createServices(env: Env): Services {
  const logger = getLogger().child({ component: 'ServiceFactory' });
  logger.info('Initializing chat orchestrator services');

  // Create the checkpointer
  const checkpointer = new D1Checkpointer(
    env.CHAT_DB,
    86400, // 24 hours TTL
  );

  // Create data retention manager
  const dataRetention = new DataRetentionManager(env.CHAT_DB, checkpointer);

  // Create search service
  const search = SearchService.fromEnv(env);

  // Initialize observability service
  // This is a static class, so we don't need to instantiate it
  const observability = ObservabilityService;

  // Return the services container
  return {
    llm: LlmService,
    search,
    observability,
    modelFactory: ModelFactory, // Static class, we export the class itself
    checkpointer,
    dataRetention,
  };
}
