import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName, environment, envConfig, commonConfig } from '../config';
import { getResourceTags, tagResource } from '../utils/tags';

// Worker script interface
interface WorkerConfig {
  name: string;
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  bindings?: Record<string, any>[];
  vars?: Record<string, string>;
  triggers?: {
    crons?: string[];
  };
}

/**
 * Create a Worker script
 * @param config Worker configuration
 * @param d1Databases D1 database resources
 * @param r2Buckets R2 bucket resources
 * @param vectorizeIndexes Vectorize index resources
 * @param queues Queue resources
 * @returns Worker script resource
 */
export function createWorker(
  config: WorkerConfig,
  d1Databases: Record<string, cloudflare.D1Database>,
  r2Buckets: Record<string, cloudflare.R2Bucket>,
  vectorizeIndexes: Record<string, cloudflare.VectorizeIndex>,
  queues: Record<string, cloudflare.WorkersQueue>
): cloudflare.WorkerScript {
  try {
    // Base configuration
    const workerConfig: cloudflare.WorkerScriptArgs = {
      name: resourceName(config.name),
      content: pulumi.interpolate`export * from '${config.mainModule}';`,
      moduleType: true,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags || [],
      plainTextBindings: {
        ...commonConfig,
        ENVIRONMENT: environment,
      },
    };

    // Add bindings
    if (config.bindings) {
      const processedBindings: Record<string, any> = {};
      
      for (const binding of config.bindings) {
        if (binding.type === 'd1Database' && binding.databaseId && d1Databases[binding.databaseId]) {
          processedBindings[binding.name] = {
            type: 'd1Database',
            databaseId: d1Databases[binding.databaseId].id,
          };
        } else if (binding.type === 'r2Bucket' && binding.bucketName && r2Buckets[binding.bucketName]) {
          processedBindings[binding.name] = {
            type: 'r2Bucket',
            bucketName: r2Buckets[binding.bucketName].name,
          };
        } else if (binding.type === 'vectorizeIndex' && binding.indexName && vectorizeIndexes[binding.indexName]) {
          processedBindings[binding.name] = {
            type: 'vectorizeIndex',
            indexName: vectorizeIndexes[binding.indexName].name,
          };
        } else if (binding.type === 'queue' && binding.queueName && queues[binding.queueName]) {
          processedBindings[binding.name] = {
            type: 'queue',
            queueName: queues[binding.queueName].name,
          };
        } else if (binding.type === 'ai') {
          processedBindings[binding.name] = {
            type: 'ai',
          };
        } else if (binding.type === 'service' && binding.service) {
          processedBindings[binding.name] = {
            type: 'service',
            service: resourceName(binding.service),
            environment: binding.environment || environment,
          };
        }
      }
      
      workerConfig.bindings = processedBindings;
    }

    // Add environment variables
    if (config.vars) {
      workerConfig.plainTextBindings = {
        ...workerConfig.plainTextBindings,
        ...config.vars,
      };
    }

    // Add triggers (crons)
    if (config.triggers && config.triggers.crons) {
      workerConfig.triggers = {
        crons: config.triggers.crons,
      };
    }

    // Add observability settings
    workerConfig.logpush = envConfig.observabilityEnabled;

    // Create the worker script
    const worker = new cloudflare.WorkerScript(config.name, workerConfig);
    
    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(worker, 'worker', config.name, {
      Service: config.name,
      Module: config.mainModule,
    });
    
    return worker;
  } catch (error) {
    // Handle errors during worker creation
    console.error(`Error creating worker ${config.name}:`, error);
    throw error;
  }
}

/**
 * Create worker definitions for all services in the monorepo
 * @param d1Databases D1 database resources
 * @param r2Buckets R2 bucket resources
 * @param vectorizeIndexes Vectorize index resources
 * @param queues Queue resources
 * @returns Record of Worker Script resources
 */
export function createWorkers(
  d1Databases: Record<string, cloudflare.D1Database>,
  r2Buckets: Record<string, cloudflare.R2Bucket>,
  vectorizeIndexes: Record<string, cloudflare.VectorizeIndex>,
  queues: Record<string, cloudflare.WorkersQueue>
): Record<string, cloudflare.WorkerScript> {
  const workers: Record<string, cloudflare.WorkerScript> = {};

  try {
    // Dome API Worker
    workers.domeApi = createWorker(
      {
        name: 'dome-api',
        mainModule: 'services/dome-api/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'ai', name: 'AI' },
          { type: 'service', name: 'CONSTELLATION', service: 'constellation' },
          { type: 'service', name: 'SILO', service: 'silo' },
        ],
        vars: {
          VERSION: '0.1.0',
          LOG_LEVEL: 'debug',
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // Silo Worker
    workers.silo = createWorker(
      {
        name: 'silo',
        mainModule: 'services/silo/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'r2Bucket', name: 'BUCKET', bucketName: 'siloContent' },
          { type: 'd1Database', name: 'DB', databaseId: 'silo' },
          { type: 'queue', name: 'NEW_CONTENT_CONSTELLATION', queueName: 'newContentConstellation' },
          { type: 'queue', name: 'NEW_CONTENT_AI', queueName: 'newContentAi' },
          { type: 'queue', name: 'CONTENT_EVENTS', queueName: 'contentEvents' },
          { type: 'queue', name: 'ENRICHED_CONTENT', queueName: 'enrichedContent' },
        ],
        vars: {
          LOG_LEVEL: 'info',
          VERSION: '1.0.0',
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // Constellation Worker
    workers.constellation = createWorker(
      {
        name: 'constellation',
        mainModule: 'services/constellation/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'queue', name: 'NEW_CONTENT_CONSTELLATION', queueName: 'newContentConstellation' },
          { type: 'queue', name: 'EMBED_DEAD', queueName: 'embedDeadLetter' },
          { type: 'vectorizeIndex', name: 'VECTORIZE', indexName: 'domeNotes' },
          { type: 'ai', name: 'AI' },
          { type: 'service', name: 'SILO', service: 'silo' },
        ],
        vars: {
          VERSION: '1.0.0',
          LOG_LEVEL: 'debug',
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // AI Processor Worker
    workers.aiProcessor = createWorker(
      {
        name: 'ai-processor',
        mainModule: 'services/ai-processor/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'queue', name: 'NEW_CONTENT', queueName: 'newContentAi' },
          { type: 'queue', name: 'ENRICHED_CONTENT', queueName: 'enrichedContent' },
          { type: 'ai', name: 'AI' },
          { type: 'service', name: 'SILO', service: 'silo' },
        ],
        vars: {
          LOG_LEVEL: 'info',
          VERSION: '0.1.0',
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // Dome Cron Worker
    workers.domeCron = createWorker(
      {
        name: 'dome-cron',
        mainModule: 'services/dome-cron/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'queue', name: 'EVENTS', queueName: 'domeEvents' },
          { type: 'd1Database', name: 'D1_DATABASE', databaseId: 'domeMeta' },
        ],
        vars: {
          VERSION: '0.1.0',
        },
        triggers: {
          crons: ['*/5 * * * *'], // Every 5 minutes
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // Dome Notify Worker
    workers.domeNotify = createWorker(
      {
        name: 'dome-notify',
        mainModule: 'services/dome-notify/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'queue', name: 'EVENTS', queueName: 'domeEvents' },
        ],
        vars: {
          VERSION: '0.1.0',
          MAIL_FROM: 'notifications@dome.example.com',
          MAIL_FROM_NAME: 'Dome Notifications',
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // Ingestion Manager Worker
    workers.ingestionManager = createWorker(
      {
        name: 'ingestion-manager',
        mainModule: 'services/ingestion-manager/src/index.ts',
        compatibilityDate: '2025-04-15',
        compatibilityFlags: ['nodejs_als'],
        bindings: [
          { type: 'd1Database', name: 'DB', databaseId: 'domeMeta' },
          { type: 'queue', name: 'EVENTS', queueName: 'domeEvents' },
          { type: 'service', name: 'SILO', service: 'silo' },
        ],
        vars: {
          VERSION: '0.1.0',
          LOG_LEVEL: 'debug',
        },
      },
      d1Databases,
      r2Buckets,
      vectorizeIndexes,
      queues
    );

    // Validate worker configurations
    for (const [key, worker] of Object.entries(workers)) {
      if (!worker.name) {
        throw new Error(`Worker ${key} has an invalid name`);
      }
    }
  } catch (error) {
    console.error('Error creating workers:', error);
    throw error;
  }

  return workers;
}