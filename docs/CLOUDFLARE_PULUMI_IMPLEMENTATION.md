# Cloudflare Pulumi Implementation Plan

This document provides a detailed implementation plan for the Pulumi infrastructure code, including code examples, file structures, and implementation steps.

## Table of Contents

- [Project Setup](#project-setup)
- [Core Resource Implementations](#core-resource-implementations)
- [Worker Implementation](#worker-implementation)
- [Service Binding Implementation](#service-binding-implementation)
- [Environment Configuration](#environment-configuration)
- [Importing Existing Resources](#importing-existing-resources)
- [CI/CD Integration](#cicd-integration)

## Project Setup

### Directory Structure

First, create the basic directory structure:

```bash
mkdir -p infra/src/{resources,stacks,utils} infra/scripts
```

### Package Configuration

Create a `package.json` file in the `infra` directory:

```json
{
  "name": "dome-infrastructure",
  "version": "1.0.0",
  "description": "Dome infrastructure as code using Pulumi",
  "main": "index.js",
  "scripts": {
    "build": "tsc",
    "preview": "pulumi preview",
    "up": "pulumi up",
    "refresh": "pulumi refresh",
    "destroy": "pulumi destroy",
    "import": "ts-node scripts/import-existing.ts",
    "validate": "ts-node scripts/validate.ts"
  },
  "dependencies": {
    "@pulumi/cloudflare": "^5.0.0",
    "@pulumi/command": "^0.7.0",
    "@pulumi/pulumi": "^3.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/node": "^18.0.0",
    "ts-node": "^10.9.1",
    "typescript": "^5.0.0"
  }
}
```

### TypeScript Configuration

Create a `tsconfig.json` file in the `infra` directory:

```json
{
  "compilerOptions": {
    "target": "ES2018",
    "module": "CommonJS",
    "moduleResolution": "node",
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": false,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "strictPropertyInitialization": false,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Pulumi Project Configuration

Create a `Pulumi.yaml` file in the `infra` directory:

```yaml
name: dome-infrastructure
runtime: nodejs
description: Dome Cloudflare infrastructure
```

### Environment-Specific Configuration

Create stack configuration files for each environment:

**Pulumi.dev.yaml**:

```yaml
config:
  cloudflare:accountId: your-account-id
  dome-infrastructure:environment: dev
  dome-infrastructure:logLevel: debug
```

**Pulumi.staging.yaml**:

```yaml
config:
  cloudflare:accountId: your-account-id
  dome-infrastructure:environment: staging
  dome-infrastructure:logLevel: info
```

**Pulumi.prod.yaml**:

```yaml
config:
  cloudflare:accountId: your-account-id
  dome-infrastructure:environment: prod
  dome-infrastructure:logLevel: info
```

### Configuration Utilities

Create a configuration file at `src/config.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';

// Configuration for the stack
const config = new pulumi.Config();

// Environment (dev, staging, prod)
export const environment = config.require('environment');

// Common configuration
export const commonConfig = {
  logLevel: config.get('logLevel') || 'info',
  version: config.get('version') || '1.0.0',
};

// Environment-specific configurations
export const environmentConfigs: Record<string, any> = {
  dev: {
    workerSuffix: '-dev',
    observabilityEnabled: true,
    headSamplingRate: 1,
  },
  staging: {
    workerSuffix: '-staging',
    observabilityEnabled: true,
    headSamplingRate: 1,
  },
  prod: {
    workerSuffix: '',
    observabilityEnabled: true,
    headSamplingRate: 1,
  },
};

// Get current environment configuration
export const envConfig = environmentConfigs[environment];

// Resource naming utility
export function resourceName(baseName: string): string {
  return environment === 'prod' ? baseName : `${baseName}${envConfig.workerSuffix}`;
}
```

## Core Resource Implementations

### D1 Databases

Create a file at `src/resources/databases.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';

// Create D1 Databases
export function createD1Databases(): Record<string, cloudflare.D1Database> {
  const databases: Record<string, cloudflare.D1Database> = {};

  // Dome Meta Database
  databases.domeMeta = new cloudflare.D1Database('dome-meta', {
    name: resourceName('dome-meta'),
  });

  // Silo Database
  databases.silo = new cloudflare.D1Database('silo', {
    name: resourceName('silo'),
  });

  return databases;
}
```

### R2 Buckets

Create a file at `src/resources/storage.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';

// Create R2 Buckets
export function createR2Buckets(): Record<string, cloudflare.R2Bucket> {
  const buckets: Record<string, cloudflare.R2Bucket> = {};

  // Dome Raw Bucket
  buckets.domeRaw = new cloudflare.R2Bucket('dome-raw', {
    name: resourceName('dome-raw'),
    location: 'wnam', // West North America
  });

  // Silo Content Bucket
  buckets.siloContent = new cloudflare.R2Bucket('silo-content', {
    name: resourceName('silo-content'),
    location: 'wnam', // West North America
  });

  return buckets;
}
```

### Vectorize Indexes

Create a file at `src/resources/vectorize.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';

// Create Vectorize Indexes
export function createVectorizeIndexes(): Record<string, cloudflare.VectorizeIndex> {
  const indexes: Record<string, cloudflare.VectorizeIndex> = {};

  // Dome Notes Index
  indexes.domeNotes = new cloudflare.VectorizeIndex('dome-notes', {
    name: resourceName('dome-notes'),
    dimensions: 1536, // Assuming OpenAI embedding dimensions
    metric: 'cosine', // Cosine similarity
  });

  return indexes;
}
```

### Queues

Create a file at `src/resources/queues.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';

// Create Queues
export function createQueues(): Record<string, cloudflare.WorkersQueue> {
  const queues: Record<string, cloudflare.WorkersQueue> = {};

  // New Content Constellation Queue
  queues.newContentConstellation = new cloudflare.WorkersQueue('new-content-constellation', {
    name: resourceName('new-content-constellation'),
  });

  // New Content AI Queue
  queues.newContentAi = new cloudflare.WorkersQueue('new-content-ai', {
    name: resourceName('new-content-ai'),
  });

  // Content Events Queue
  queues.contentEvents = new cloudflare.WorkersQueue('content-events', {
    name: resourceName('content-events'),
  });

  // Enriched Content Queue
  queues.enrichedContent = new cloudflare.WorkersQueue('enriched-content', {
    name: resourceName('enriched-content'),
  });

  // Dome Events Queue
  queues.domeEvents = new cloudflare.WorkersQueue('dome-events', {
    name: resourceName('dome-events'),
  });

  // Embed Dead Letter Queue
  queues.embedDeadLetter = new cloudflare.WorkersQueue('embed-dead-letter', {
    name: resourceName('embed-dead-letter'),
  });

  return queues;
}
```

## Worker Implementation

### Worker Script Resources

Create a file at `src/resources/workers.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName, environment, envConfig, commonConfig } from '../config';

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

// Create a Worker script
export function createWorker(
  config: WorkerConfig,
  d1Databases: Record<string, cloudflare.D1Database>,
  r2Buckets: Record<string, cloudflare.R2Bucket>,
  vectorizeIndexes: Record<string, cloudflare.VectorizeIndex>,
  queues: Record<string, cloudflare.WorkersQueue>,
): cloudflare.WorkerScript {
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
      } else if (
        binding.type === 'r2Bucket' &&
        binding.bucketName &&
        r2Buckets[binding.bucketName]
      ) {
        processedBindings[binding.name] = {
          type: 'r2Bucket',
          bucketName: r2Buckets[binding.bucketName].name,
        };
      } else if (
        binding.type === 'vectorizeIndex' &&
        binding.indexName &&
        vectorizeIndexes[binding.indexName]
      ) {
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
  return new cloudflare.WorkerScript(config.name, workerConfig);
}

// Create all worker scripts
export function createWorkers(
  d1Databases: Record<string, cloudflare.D1Database>,
  r2Buckets: Record<string, cloudflare.R2Bucket>,
  vectorizeIndexes: Record<string, cloudflare.VectorizeIndex>,
  queues: Record<string, cloudflare.WorkersQueue>,
): Record<string, cloudflare.WorkerScript> {
  const workers: Record<string, cloudflare.WorkerScript> = {};

  // Dome API Worker
  workers.domeApi = createWorker(
    {
      name: 'dome-api',
      mainModule: 'src/index.ts',
      compatibilityDate: '2025-04-15',
      compatibilityFlags: ['nodejs_als'],
      bindings: [
        { type: 'ai', name: 'AI' },
        {
          type: 'service',
          name: 'CONSTELLATION',
          service: 'constellation',
          environment: 'production',
        },
        { type: 'service', name: 'SILO', service: 'silo', environment: 'production' },
      ],
      vars: {
        VERSION: '0.1.0',
        LOG_LEVEL: 'debug',
      },
    },
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
  );

  // Silo Worker
  workers.silo = createWorker(
    {
      name: 'silo',
      mainModule: 'src/index.ts',
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
        ENVIRONMENT: environment,
      },
    },
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
  );

  // Constellation Worker
  workers.constellation = createWorker(
    {
      name: 'constellation',
      mainModule: 'src/index.ts',
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
    queues,
  );

  // AI Processor Worker
  workers.aiProcessor = createWorker(
    {
      name: 'ai-processor',
      mainModule: 'src/index.ts',
      compatibilityDate: '2025-04-15',
      compatibilityFlags: ['nodejs_compat'],
      bindings: [
        { type: 'queue', name: 'NEW_CONTENT', queueName: 'newContentAi' },
        { type: 'queue', name: 'ENRICHED_CONTENT', queueName: 'enrichedContent' },
        { type: 'ai', name: 'AI' },
        { type: 'service', name: 'SILO', service: 'silo' },
      ],
      vars: {
        LOG_LEVEL: 'info',
        VERSION: '0.1.0',
        ENVIRONMENT: environment,
      },
    },
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
  );

  // Dome Cron Worker
  workers.domeCron = createWorker(
    {
      name: 'dome-cron',
      mainModule: 'src/index.ts',
      compatibilityDate: '2025-04-15',
      compatibilityFlags: ['nodejs_als'],
      bindings: [
        { type: 'queue', name: 'EVENTS', queueName: 'domeEvents' },
        { type: 'd1Database', name: 'D1_DATABASE', databaseId: 'domeMeta' },
      ],
      vars: {
        VERSION: '0.1.0',
        ENVIRONMENT: environment,
      },
      triggers: {
        crons: ['*/5 * * * *'], // Every 5 minutes
      },
    },
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
  );

  // Dome Notify Worker
  workers.domeNotify = createWorker(
    {
      name: 'dome-notify',
      mainModule: 'src/index.ts',
      compatibilityDate: '2023-05-18',
      compatibilityFlags: ['nodejs_als'],
      vars: {
        ENVIRONMENT: environment,
        VERSION: '0.1.0',
        MAIL_FROM: 'notifications@dome.example.com',
        MAIL_FROM_NAME: 'Dome Notifications',
        SLACK_WEBHOOK_URL: '', // Set this in production
      },
    },
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
  );

  return workers;
}
```

## Service Binding Implementation

### Service Bindings

Create a file at `src/resources/bindings.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { environment } from '../config';

// Create service bindings between workers
export function createServiceBindings(
  workers: Record<string, cloudflare.WorkerScript>,
): cloudflare.ServiceBinding[] {
  const bindings: cloudflare.ServiceBinding[] = [];

  // Dome API to Constellation
  bindings.push(
    new cloudflare.ServiceBinding('dome-api-to-constellation', {
      service: workers.constellation.name,
      environment: environment,
      name: 'CONSTELLATION',
      scriptName: workers.domeApi.name,
    }),
  );

  // Dome API to Silo
  bindings.push(
    new cloudflare.ServiceBinding('dome-api-to-silo', {
      service: workers.silo.name,
      environment: environment,
      name: 'SILO',
      scriptName: workers.domeApi.name,
    }),
  );

  // Constellation to Silo
  bindings.push(
    new cloudflare.ServiceBinding('constellation-to-silo', {
      service: workers.silo.name,
      environment: environment,
      name: 'SILO',
      scriptName: workers.constellation.name,
    }),
  );

  // AI Processor to Silo
  bindings.push(
    new cloudflare.ServiceBinding('ai-processor-to-silo', {
      service: workers.silo.name,
      environment: environment,
      name: 'SILO',
      scriptName: workers.aiProcessor.name,
    }),
  );

  return bindings;
}
```

## Environment Configuration

### Environment-Specific Stacks

Create files for each environment:

**src/stacks/dev.ts**:

```typescript
import * as pulumi from '@pulumi/pulumi';
import { createD1Databases } from '../resources/databases';
import { createR2Buckets } from '../resources/storage';
import { createVectorizeIndexes } from '../resources/vectorize';
import { createQueues } from '../resources/queues';
import { createWorkers } from '../resources/workers';
import { createServiceBindings } from '../resources/bindings';

export function createDevStack(): Record<string, any> {
  // Create resources
  const d1Databases = createD1Databases();
  const r2Buckets = createR2Buckets();
  const vectorizeIndexes = createVectorizeIndexes();
  const queues = createQueues();
  const workers = createWorkers(d1Databases, r2Buckets, vectorizeIndexes, queues);
  const serviceBindings = createServiceBindings(workers);

  // Export outputs
  return {
    d1Databases,
    r2Buckets,
    vectorizeIndexes,
    queues,
    workers,
    serviceBindings,
  };
}
```

Similar files would be created for staging and production environments.

### Main Entry Point

Create the main entry point at `infra/index.ts`:

```typescript
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
```

## Importing Existing Resources

Create a script to import existing resources at `infra/scripts/import-existing.ts`:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Configure Pulumi to use the specified stack
const stack = process.argv[2] || 'dev';
console.log(`Importing resources for stack: ${stack}`);

// Set the Pulumi stack
try {
  execSync(`pulumi stack select ${stack}`, { stdio: 'inherit' });
} catch (error) {
  console.error(`Failed to select stack: ${stack}`);
  process.exit(1);
}

// Import D1 Databases
async function importD1Databases() {
  console.log('Importing D1 Databases...');

  // Example: Import dome-meta database
  try {
    execSync('pulumi import cloudflare:index/d1Database:D1Database dome-meta dome-meta', {
      stdio: 'inherit',
    });
    console.log('Imported dome-meta database');
  } catch (error) {
    console.error('Failed to import dome-meta database');
  }

  // Example: Import silo database
  try {
    execSync('pulumi import cloudflare:index/d1Database:D1Database silo silo', {
      stdio: 'inherit',
    });
    console.log('Imported silo database');
  } catch (error) {
    console.error('Failed to import silo database');
  }
}

// Import R2 Buckets
async function importR2Buckets() {
  console.log('Importing R2 Buckets...');

  // Example: Import dome-raw bucket
  try {
    execSync('pulumi import cloudflare:index/r2Bucket:R2Bucket dome-raw dome-raw', {
      stdio: 'inherit',
    });
    console.log('Imported dome-raw bucket');
  } catch (error) {
    console.error('Failed to import dome-raw bucket');
  }

  // Example: Import silo-content bucket
  try {
    execSync('pulumi import cloudflare:index/r2Bucket:R2Bucket silo-content silo-content', {
      stdio: 'inherit',
    });
    console.log('Imported silo-content bucket');
  } catch (error) {
    console.error('Failed to import silo-content bucket');
  }
}

// Import Workers
async function importWorkers() {
  console.log('Importing Workers...');

  // Example: Import dome-api worker
  try {
    execSync('pulumi import cloudflare:index/workerScript:WorkerScript dome-api dome-api', {
      stdio: 'inherit',
    });
    console.log('Imported dome-api worker');
  } catch (error) {
    console.error('Failed to import dome-api worker');
  }

  // Import other workers similarly
}

// Run the import process
async function runImport() {
  await importD1Databases();
  await importR2Buckets();
  await importWorkers();
  // Add other import functions as needed

  console.log('Import process completed');
}

runImport().catch(error => {
  console.error('Import process failed:', error);
  process.exit(1);
});
```

## CI/CD Integration

Create a GitHub Actions workflow file at `.github/workflows/infrastructure.yml`:

```yaml
name: Infrastructure Deployment

on:
  push:
    branches:
      - main
    paths:
      - 'infra/**'
      - '.github/workflows/infrastructure.yml'
  pull_request:
    paths:
      - 'infra/**'
      - '.github/workflows/infrastructure.yml'
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        default: 'dev'
        type: choice
        options:
          - dev
          - staging
          - prod

jobs:
  preview:
    name: Preview Infrastructure Changes
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'

      - name: Install dependencies
        run: |
          cd infra
          pnpm install

      - name: Setup Pulumi
        uses: pulumi/actions@v4

      - name: Preview infrastructure changes
        run: |
          cd infra
          pulumi stack select ${{ github.event.inputs.environment || 'dev' }}
          pulumi preview
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

  deploy:
    name: Deploy Infrastructure
    runs-on: ubuntu-latest
    needs: preview
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'
    environment: ${{ github.event.inputs.environment || 'dev' }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'

      - name: Install dependencies
        run: |
          cd infra
          pnpm install

      - name: Setup Pulumi
        uses: pulumi/actions@v4

      - name: Deploy infrastructure changes
        run: |
          cd infra
          pulumi stack select ${{ github.event.inputs.environment || 'dev' }}
          pulumi up --yes
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

This implementation plan provides a detailed starting point for implementing the Pulumi infrastructure code for your Cloudflare resources. The code examples and file structures can be adapted as needed based on your specific requirements.
