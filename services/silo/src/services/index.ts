import { createR2Service, R2Service } from './r2Service';
import { createMetadataService, MetadataService } from './metadataService';
import { createQueueService, QueueService } from './queueService';
import { createContentController, ContentController } from '../controllers/contentController';
import { createStatsController, StatsController } from '../controllers/statsController';
import { createQueueController, QueueController } from '../controllers/queueController';

/**
 * Service container interface
 */
export interface Services {
  content: ContentController;
  queue: QueueController;
  stats: StatsController;
}

/**
 * Create and initialize all services
 */
export function createServices(env: any): Services {
  // Create service wrappers around external services
  const r2Service = createR2Service(env);
  const metadataService = createMetadataService(env);
  const queueService = createQueueService(env);

  // Create controllers that coordinate between services
  return {
    content: createContentController(env, r2Service, metadataService, queueService),
    queue: createQueueController(env, r2Service, metadataService, queueService),
    stats: createStatsController(env, metadataService),
  };
}
