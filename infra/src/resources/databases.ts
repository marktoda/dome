import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../utils/naming';

/**
 * Create D1 databases
 * @returns Record of D1 database resources
 */
export function createD1Databases(): Record<string, cloudflare.D1Database> {
  const databases: Record<string, cloudflare.D1Database> = {};

  // Create Silo database
  databases.silo = new cloudflare.D1Database('silo', {
    name: resourceName('silo'),
  });

  // Create Dome Meta database
  databases.domeMeta = new cloudflare.D1Database('dome-meta', {
    name: resourceName('dome-meta'),
  });

  // Create Chat Orchestrator database
  databases.chatOrchestrator = new cloudflare.D1Database('chat-orchestrator', {
    name: resourceName('chat-orchestrator'),
  });

  return databases;
}
