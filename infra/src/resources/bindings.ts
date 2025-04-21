import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { environment } from '../config';

/**
 * Create service bindings between workers
 * @param workers Worker script resources
 * @returns Array of service binding resources
 */
export function createServiceBindings(
  workers: Record<string, cloudflare.WorkerScript>
): cloudflare.ServiceBinding[] {
  const bindings: cloudflare.ServiceBinding[] = [];
  
  // Dome API to Constellation
  if (workers.domeApi && workers.constellation) {
    bindings.push(
      new cloudflare.ServiceBinding('dome-api-to-constellation', {
        service: workers.constellation.name,
        environment: environment,
        name: 'CONSTELLATION',
        scriptName: workers.domeApi.name,
      })
    );
  }

  // Dome API to Silo
  if (workers.domeApi && workers.silo) {
    bindings.push(
      new cloudflare.ServiceBinding('dome-api-to-silo', {
        service: workers.silo.name,
        environment: environment,
        name: 'SILO',
        scriptName: workers.domeApi.name,
      })
    );
  }

  // Constellation to Silo
  if (workers.constellation && workers.silo) {
    bindings.push(
      new cloudflare.ServiceBinding('constellation-to-silo', {
        service: workers.silo.name,
        environment: environment,
        name: 'SILO',
        scriptName: workers.constellation.name,
      })
    );
  }

  // AI Processor to Silo
  if (workers.aiProcessor && workers.silo) {
    bindings.push(
      new cloudflare.ServiceBinding('ai-processor-to-silo', {
        service: workers.silo.name,
        environment: environment,
        name: 'SILO',
        scriptName: workers.aiProcessor.name,
      })
    );
  }
  
  // Ingestion Manager to Silo
  if (workers.ingestionManager && workers.silo) {
    bindings.push(
      new cloudflare.ServiceBinding('ingestion-manager-to-silo', {
        service: workers.silo.name,
        environment: environment,
        name: 'SILO',
        scriptName: workers.ingestionManager.name,
      })
    );
  }

  return bindings;
}