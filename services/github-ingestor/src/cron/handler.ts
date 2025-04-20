import { Env } from '../types';

/**
 * Interface for execution context
 */
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}
import { CronService } from './service';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';

/**
 * Maximum number of repositories to process in a single cron run
 */
const MAX_REPOSITORIES = 50;

/**
 * Maximum number of repositories to process in parallel
 */
const CONCURRENCY_LIMIT = 5;

/**
 * Handle scheduled cron events
 * @param env Environment
 * @param ctx Execution context
 */
export async function handleCron(env: Env, ctx: ExecutionContext): Promise<void> {
  const startTime = Date.now();
  const cronService = new CronService(env);
  
  logger.info('Starting cron handler for GitHub repository sync');
  metrics.counter('cron.handler.invocations', 1);
  
  try {
    // Get repositories due for sync
    const repositories = await cronService.getRepositoriesToSync(MAX_REPOSITORIES);
    
    if (repositories.length === 0) {
      logger.info('No repositories need to be synced');
      metrics.timing('cron.handler.duration_ms', Date.now() - startTime);
      return;
    }
    
    // Prioritize repositories
    const prioritizedRepos = cronService.prioritizeRepositories(repositories);
    
    logger.info({ count: prioritizedRepos.length }, 'Processing repositories for sync');
    metrics.gauge('cron.handler.repositories_to_sync', prioritizedRepos.length);
    
    // Process repositories in batches with concurrency limit
    for (let i = 0; i < prioritizedRepos.length; i += CONCURRENCY_LIMIT) {
      const batch = prioritizedRepos.slice(i, i + CONCURRENCY_LIMIT);
      
      // Process batch in parallel
      await Promise.all(batch.map(async (repo) => {
        try {
          // Check if repository needs to be synced
          const { needsSync, commitSha, etag } = await cronService.checkRepositoryForUpdates(repo);
          
          if (needsSync) {
            // Enqueue repository for ingestion
            await cronService.enqueueRepository(repo, commitSha, etag);
          }
        } catch (error) {
          logError(error as Error, `Failed to process repository ${repo.owner}/${repo.repo}`);
          metrics.counter('cron.handler.repository_errors', 1, {
            owner: repo.owner,
            repo: repo.repo
          });
        }
      }));
      
      // Yield to avoid CPU time limit if there are more batches to process
      if (i + CONCURRENCY_LIMIT < prioritizedRepos.length) {
        await new Promise(resolve => setTimeout(resolve, 1));
        
        // Check if we're running out of time (30 seconds is a safe limit for a 60-second cron)
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > 30000) {
          logger.warn(
            { processed: i + CONCURRENCY_LIMIT, total: prioritizedRepos.length, elapsedTime },
            'Approaching time limit, stopping early'
          );
          metrics.counter('cron.handler.early_terminations', 1);
          break;
        }
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info({ duration }, 'Completed cron handler for GitHub repository sync');
    metrics.timing('cron.handler.duration_ms', duration);
  } catch (error) {
    const duration = Date.now() - startTime;
    logError(error as Error, 'Error in cron handler');
    metrics.counter('cron.handler.errors', 1);
    metrics.timing('cron.handler.duration_ms', duration);
  }
}

/**
 * Process a single repository
 * @param cronService Cron service
 * @param repo Repository configuration
 * @returns Whether the repository was processed successfully
 */
async function processRepository(cronService: CronService, repo: any): Promise<boolean> {
  const timer = metrics.startTimer('cron.handler.process_repository');
  
  try {
    // Check if repository needs to be synced
    const { needsSync, commitSha, etag } = await cronService.checkRepositoryForUpdates(repo);
    
    if (needsSync) {
      // Enqueue repository for ingestion
      await cronService.enqueueRepository(repo, commitSha, etag);
    }
    
    timer.stop({ synced: needsSync.toString() });
    return true;
  } catch (error) {
    timer.stop({ error: 'true' });
    logError(error as Error, `Failed to process repository ${repo.owner}/${repo.repo}`);
    metrics.counter('cron.handler.repository_errors', 1, {
      owner: repo.owner,
      repo: repo.repo
    });
    return false;
  }
}