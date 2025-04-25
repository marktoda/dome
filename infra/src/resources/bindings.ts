import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../utils/naming';

/**
 * Create service bindings for workers
 * @param workers Record of worker resources
 * @returns Record of service binding resources
 */
export function createServiceBindings(
  workers: Record<string, cloudflare.WorkerScript>
): Record<string, cloudflare.ServiceBinding> {
  const bindings: Record<string, cloudflare.ServiceBinding> = {};

  // Create service binding for dome-api to constellation
  bindings.domeApiToConstellation = new cloudflare.ServiceBinding('dome-api-to-constellation', {
    name: 'CONSTELLATION',
    service: workers.constellation.name,
    environment: 'production',
  });

  // Create service binding for dome-api to silo
  bindings.domeApiToSilo = new cloudflare.ServiceBinding('dome-api-to-silo', {
    name: 'SILO',
    service: workers.silo.name,
    environment: 'production',
  });

  // Create service binding for constellation to silo
  bindings.constellationToSilo = new cloudflare.ServiceBinding('constellation-to-silo', {
    name: 'SILO',
    service: workers.silo.name,
    environment: 'production',
  });

  // Create service binding for ai-processor to silo
  bindings.aiProcessorToSilo = new cloudflare.ServiceBinding('ai-processor-to-silo', {
    name: 'SILO',
    service: workers.silo.name,
    environment: 'production',
  });

  // Create service binding for ingestion-manager to silo
  bindings.ingestionManagerToSilo = new cloudflare.ServiceBinding('ingestion-manager-to-silo', {
    name: 'SILO',
    service: workers.silo.name,
    environment: 'production',
  });

  // Create service binding for dome-api to chat-orchestrator
  bindings.domeApiToChatOrchestrator = new cloudflare.ServiceBinding('dome-api-to-chat-orchestrator', {
    name: 'CHAT_ORCHESTRATOR',
    service: workers.chatOrchestrator.name,
    environment: 'production',
  });

  return bindings;
}
