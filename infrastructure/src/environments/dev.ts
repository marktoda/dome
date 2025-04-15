import * as pulumi from '@pulumi/pulumi';
import { deployWorker } from '../workers';

// Load configuration
const config = new pulumi.Config();
const accountId = config.require('cloudflare:accountId');

/**
 * Deploy the development environment
 */
export function dev() {
  // Deploy the ingestor worker
  const ingestorWorker = deployWorker('ingestor-dev', '../services/ingestor/dist/index.js', {
    accountId,
    routes: [
      // Example route - update as needed
      // 'ingestor-dev.your-domain.com/*',
    ],
  });

  // Note: Environment variables are removed due to TypeScript compatibility issues
  // TODO: Add environment variables back once the Pulumi Cloudflare provider types are resolved

  // Export the worker details
  return {
    ingestorWorker: {
      name: ingestorWorker.name,
    },
  };
}