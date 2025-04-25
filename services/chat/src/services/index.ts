import { getLogger } from '@dome/logging';
import { LlmService } from './llmService';
import { SearchService } from './searchService';
import { ObservabilityService } from './observabilityService';
import { SecureD1Checkpointer } from '../checkpointer/secureD1Checkpointer';
import { DataRetentionManager } from '../utils/dataRetentionManager';
import { initializeToolRegistry } from '../tools/secureToolExecutor';

/**
 * Service container interface
 */
export interface Services {
  llm: LlmService;
  search: SearchService;
  observability: ObservabilityService;
  checkpointer: SecureD1Checkpointer;
  dataRetention: DataRetentionManager;
  toolRegistry: any; // Using any for now, will be properly typed later
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
  const checkpointer = new SecureD1Checkpointer(
    env.CHAT_DB,
    env,
    undefined, // No Hono context in RPC
    86400, // 24 hours TTL
  );

  // Create data retention manager
  const dataRetention = new DataRetentionManager(env.CHAT_DB, checkpointer);

  // Initialize tool registry
  const toolRegistry = initializeToolRegistry();

  // Create service instances
  const llm = new LlmService();
  const search = SearchService.fromEnv(env);
  const observability = new ObservabilityService();

  // Return the services container
  return {
    llm,
    search,
    observability,
    checkpointer,
    dataRetention,
    toolRegistry,
  };
}
