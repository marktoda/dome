import { Miniflare as OriginalMiniflare } from 'miniflare';

// Extend the Miniflare type to include additional methods
export interface ExtendedMiniflare extends Omit<OriginalMiniflare, 'dispatchFetch'> {
  dispatchCron(cronPattern: string): Promise<void>;
  dispatchQueue(queueName: string, message: any): Promise<void>;
  dispatchFetch(url: string | URL | Request, init?: RequestInit): Promise<Response>;
}

// Define the D1Database configuration type
export interface D1DatabaseOptions {
  binding: string;
  database: string;
  migrationsPath: string;
}

// Define the service binding type
export interface ServiceBinding {
  fetch: any;
  [key: string]: any;
}

// Define the Miniflare options type
export interface MiniflareOptions {
  modules: boolean;
  scriptPath: string;
  bindings: Record<string, string>;
  d1Databases: D1DatabaseOptions[];
  queueConsumers: string[];
  serviceBindings: Record<string, ServiceBinding>;
}

// Type assertion function to cast Miniflare to ExtendedMiniflare
export function asMiniflareWithCron(mf: OriginalMiniflare): ExtendedMiniflare {
  return mf as unknown as ExtendedMiniflare;
}
