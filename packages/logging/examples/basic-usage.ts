import { withLogger, getLogger } from '../src';

// Example function that uses getLogger to retrieve the logger from ALS
async function processItem(item: any) {
  const log = getLogger();
  log.debug({ item }, 'Processing item');
  
  // Simulate some processing
  await new Promise(resolve => setTimeout(resolve, 100));
  
  log.info({ itemId: item.id }, 'Item processed successfully');
  return { ...item, processed: true };
}

// Example Cloudflare Worker
export default {
  // Fetch handler example
  async fetch(request: Request, env: any, ctx: any) {
    return withLogger(
      {
        svc: 'example-api',
        op: 'fetch_handler',
        path: new URL(request.url).pathname,
        method: request.method,
        env: env.ENVIRONMENT,
        ver: env.VERSION,
      },
      async (log) => {
        log.info('Request received');
        
        try {
          // Process some data
          const data = { id: '123', name: 'Example' };
          const result = await processItem(data);
          
          // Log success and return response
          log.info({ result }, 'Request handled successfully');
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          // Error handling with automatic stack trace bubbling
          log.error(error, 'Request handling failed');
          return new Response('Internal Server Error', { status: 500 });
        }
      }
    );
  },
  
  // Queue handler example
  async queue(batch: any, env: any, ctx: any) {
    return withLogger(
      {
        svc: 'example-worker',
        op: 'queue_consumer',
        batchSize: batch.messages.length,
        env: env.ENVIRONMENT,
        ver: env.VERSION,
      },
      async (log) => {
        log.info('Processing batch');
        
        const results = [];
        for (const message of batch.messages) {
          try {
            const data = JSON.parse(message.body);
            const result = await processItem(data);
            results.push(result);
            message.ack();
          } catch (error) {
            log.error(error, `Failed to process message ${message.id}`);
            message.retry();
          }
        }
        
        log.info({ processedCount: results.length }, 'Batch processing complete');
      }
    );
  },
  
  // Scheduled handler example
  async scheduled(event: any, env: any, ctx: any) {
    return withLogger(
      {
        svc: 'example-cron',
        op: 'scheduled_job',
        cron: event.cron,
        env: env.ENVIRONMENT,
        ver: env.VERSION,
      },
      async (log) => {
        log.info('Running scheduled job');
        
        try {
          // Simulate some scheduled work
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Log metrics
          log.info({ 
            metric: 'job.duration_ms', 
            value: 500,
            job: 'example'
          }, 'Job completed');
        } catch (error) {
          log.error(error, 'Scheduled job failed');
          throw error; // Re-throw to mark the job as failed
        }
      }
    );
  }
};