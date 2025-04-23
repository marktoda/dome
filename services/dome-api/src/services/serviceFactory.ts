import { Bindings } from '../types';
import { getLogger } from '@dome/logging';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { ConstellationService } from './constellationService';
import { SearchService } from './searchService';
import { ChatService } from './chatService';

/**
 * Service factory interface
 * This provides a consistent way to access all services
 */
export interface ServiceFactory {
  getConstellationService(env: Bindings): ConstellationService;
  getSearchService(env: Bindings): SearchService;
  getChatService(env: Bindings): ChatService;
}

/**
 * Service factory implementation
 * Creates and manages service instances
 */
export class DefaultServiceFactory implements ServiceFactory {
  // We'll use Maps to store service instances by env reference
  private constellationServices: Map<Bindings, ConstellationService> = new Map();
  private searchServices: Map<Bindings, SearchService> = new Map();
  private chatServices: Map<Bindings, ChatService> = new Map();
  private siloServices: Map<Bindings, SiloClient> = new Map();
  private logger = getLogger();

  constructor() {
    this.logger.debug('Service factory initialized');
  }

  /**
   * Get the constellation service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ConstellationService instance
   */
  getConstellationService(env: Bindings): ConstellationService {
    let service = this.constellationServices.get(env);
    if (!service) {
      this.logger.debug('Creating new ConstellationService instance');
      service = new ConstellationService(env);
      this.constellationServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the search service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns SearchService instance
   */
  getSearchService(env: Bindings): SearchService {
    let service = this.searchServices.get(env);
    if (!service) {
      this.logger.debug('Creating new SearchService instance');
      const constellationService = this.getConstellationService(env);
      const siloService = this.getSiloService(env);
      service = new SearchService(constellationService, siloService);
      this.searchServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the silo service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ChatService instance
   */
  getSiloService(env: Bindings): SiloClient {
    let service = this.siloServices.get(env);
    if (!service) {
      this.logger.debug('Creating new SiloClient instance');
      service = new SiloClient(env.SILO as unknown as SiloBinding, env.SILO_INGEST_QUEUE);
      this.siloServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the chat service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ChatService instance
   */
  getChatService(env: Bindings): ChatService {
    let service = this.chatServices.get(env);
    if (!service) {
      this.logger.debug('Creating new ChatService instance');
      const searchService = this.getSearchService(env);
      service = new ChatService(searchService);
      this.chatServices.set(env, service);
    }
    return service;
  }
}

/**
 * Create a service factory instance
 * @returns ServiceFactory instance
 */
export function createServiceFactory(): ServiceFactory {
  return new DefaultServiceFactory();
}
