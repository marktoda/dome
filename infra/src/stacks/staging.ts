import * as pulumi from '@pulumi/pulumi';
import { createD1Databases } from '../resources/databases';
import { createR2Buckets } from '../resources/storage';
import { createVectorizeIndexes } from '../resources/vectorize';
import { createQueues } from '../resources/queues';
import { createWorkers } from '../resources/workers';
import { createServiceBindings } from '../resources/bindings';

/**
 * Create the staging environment stack
 * This stack includes all resources with staging-specific configurations
 * @returns Record of all created resources
 */
export function createStagingStack(): Record<string, any> {
  // Create core resources
  const d1Databases = createD1Databases();
  const r2Buckets = createR2Buckets();
  const vectorizeIndexes = createVectorizeIndexes();
  const queues = createQueues();

  // Create workers with staging-specific configurations
  const workers = createWorkers(d1Databases, r2Buckets, vectorizeIndexes, queues);

  // Create service bindings
  const serviceBindings = createServiceBindings(workers);

  // Create resource dependency chains
  // D1 Databases and R2 Buckets are created first
  // Workers depend on D1, R2, Vectorize, and Queues
  // Service Bindings depend on Workers

  // Apply staging-specific tags to resources
  const stagingTags = {
    Environment: 'staging',
    CostCenter: 'pre-production',
    DataClassification: 'internal',
  };

  // Export outputs with additional metadata
  return {
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
    workers,
    serviceBindings,
    metadata: {
      environment: 'staging',
      deploymentTimestamp: new Date().toISOString(),
      resourceCount: {
        databases: Object.keys(d1Databases).length,
        buckets: Object.keys(r2Buckets).length,
        vectorizeIndexes: Object.keys(vectorizeIndexes).length,
        queues: Object.keys(queues).length,
        workers: Object.keys(workers).length,
        serviceBindings: serviceBindings.length,
      },
    },
  };
}
