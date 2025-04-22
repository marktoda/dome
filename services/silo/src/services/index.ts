import { createR2Service } from './r2Service';
import { createMetadataService } from './metadataService';
import { createQueueService } from './queueService';
import { createDLQService } from './dlqService';
import { createContentController, ContentController } from '../controllers/contentController';
import { createStatsController, StatsController } from '../controllers/statsController';
import { createDLQController, DLQController } from '../controllers/dlqController';

/**
 * Service container interface
 */
export interface Services {
  content: ContentController;
  stats: StatsController;
  dlq: DLQController;
}

/**
 * Create and initialize all services
 */
export function createServices(env: Env): Services {
  // Create service wrappers around external services
  const r2Service = createR2Service(env);
  const metadataService = createMetadataService(env);
  const queueService = createQueueService(env);
  const dlqService = createDLQService(env);

  // Create controllers that coordinate between services
  return {
    content: createContentController(env, r2Service, metadataService, queueService),
    stats: createStatsController(env, metadataService),
    dlq: createDLQController(env, dlqService),
  };
}
