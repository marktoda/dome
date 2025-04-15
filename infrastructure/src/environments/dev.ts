import * as pulumi from '@pulumi/pulumi';
import { deployWorker } from '../workers';

// Load configuration
const config = new pulumi.Config();
const accountId = config.require('cloudflare:accountId');

/**
 * Deploy the development environment
 */
export function dev() {
  // Deploy the auth-telegram worker
  const authTelegramWorker = deployWorker('auth-telegram-dev', '../services/auth-telegram/dist/index.js', {
    accountId,
    routes: [
      // Example route - update as needed
      // 'auth-telegram-dev.your-domain.com/*',
    ],
  });

  // Deploy the ingestor worker with service binding to auth-telegram
  const ingestorWorker = deployWorker('ingestor-dev', '../services/ingestor/dist/index.js', {
    accountId,
    routes: [
      // Example route - update as needed
      // 'ingestor-dev.your-domain.com/*',
    ],
    serviceBindings: [
      {
        name: 'TELEGRAM_AUTH',
        service: authTelegramWorker.name,
      },
    ],
  });

  // Note: Environment variables are removed due to TypeScript compatibility issues
  // TODO: Add environment variables back once the Pulumi Cloudflare provider types are resolved

  // Export the worker details
  return {
    authTelegramWorker: {
      name: authTelegramWorker.name,
    },
    ingestorWorker: {
      name: ingestorWorker.name,
    },
  };
}