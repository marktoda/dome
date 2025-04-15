import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Deploy a TypeScript Cloudflare Worker
 *
 * @param name The name of the worker
 * @param scriptPath The path to the worker script
 * @param options Additional options for the worker
 * @returns The deployed worker
 */
export function deployWorker(
  name: string,
  scriptPath: string,
  options: {
    accountId: string;
    routes?: string[];
    serviceBindings?: { name: string; service: pulumi.Input<string> }[];
  }
): cloudflare.WorkerScript {
  // Create the worker script
  const worker = new cloudflare.WorkerScript(name, {
    name,
    accountId: options.accountId,
    content: fs.readFileSync(scriptPath, 'utf8'),
    serviceBindings: options.serviceBindings,
  });

  // Create routes for the worker if specified
  if (options.routes && options.routes.length > 0) {
    for (let i = 0; i < options.routes.length; i++) {
      const route = options.routes[i];
      new cloudflare.WorkerRoute(`${name}-route-${i}`, {
        zoneId: options.accountId,
        pattern: route,
        scriptName: worker.name,
      });
    }
  }

  return worker;
}

/**
 * Deploy a Rust Cloudflare Worker
 *
 * @param name The name of the worker
 * @param wasmPath The path to the compiled WebAssembly file
 * @param options Additional options for the worker
 * @returns The deployed worker
 */
export function deployRustWorker(
  name: string,
  wasmPath: string,
  options: {
    accountId: string;
    routes?: string[];
  }
): cloudflare.WorkerScript {
  // Create the worker script with WebAssembly content
  const worker = new cloudflare.WorkerScript(name, {
    name,
    accountId: options.accountId,
    content: fs.readFileSync(wasmPath).toString('base64'),
  });

  // Create routes for the worker if specified
  if (options.routes && options.routes.length > 0) {
    for (let i = 0; i < options.routes.length; i++) {
      const route = options.routes[i];
      new cloudflare.WorkerRoute(`${name}-route-${i}`, {
        zoneId: options.accountId,
        pattern: route,
        scriptName: worker.name,
      });
    }
  }

  return worker;
}