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

  // Initialize LLM service with environment configuration
  // This configures the default model and other LLM-related settings
  LlmService.initialize(env);
  const llm = LlmService;

  // Create search service
  const search = SearchService.fromEnv(env);

  // Initialize observability service
  // This is a static class, so we don't need to instantiate it
  const observability = ObservabilityService;

  // Log which model is being used
  logger.info(
    {
      modelId: LlmService.MODEL,
      // Get provider information from the configured model
      modelProvider:
        'DEFAULT_MODEL_ID' in env ? String(env.DEFAULT_MODEL_ID) : 'default (GPT_4_TURBO)',
    },
    'Chat service using initialized LLM model',
  );

  // Return the services container
  return {
    llm,
    search,
    observability,
    modelFactory: ModelFactory, // Static class, we export the class itself
    checkpointer,
    dataRetention,
  };
}
