import * as pulumi from '@pulumi/pulumi';
import { environment } from './src/config';
import { createDevStack } from './src/stacks/dev';
import { createStagingStack } from './src/stacks/staging';
import { createProdStack } from './src/stacks/prod';

// Select the appropriate stack based on the environment
let resources: Record<string, any>;

switch (environment) {
  case 'dev':
    resources = createDevStack();
    break;
  case 'staging':
    resources = createStagingStack();
    break;
  case 'prod':
    resources = createProdStack();
    break;
  default:
    throw new Error(`Unknown environment: ${environment}`);
}

// Export outputs
export const d1Databases = resources.d1Databases;
export const r2Buckets = resources.r2Buckets;
export const vectorizeIndexes = resources.vectorizeIndexes;
export const queues = resources.queues;
export const workers = resources.workers;
export const serviceBindings = resources.serviceBindings;

// Export environment information
export const currentEnvironment = environment;