import { Bindings } from '../types';
import { getLogger } from '@dome/common';
import { SiloClient, createSiloClient, SiloBinding } from '@dome/silo/client';
import { ConstellationClient, ConstellationBinding } from '@dome/constellation/client';
import { AiProcessorClient, AiProcessorBinding } from '@dome/ai-processor/client';
import { SearchService } from './searchService';
import { ChatClient } from '@dome/chat/client';
import { TsunamiClient, TsunamiBinding } from '@dome/tsunami/client';
import { createAuthServiceFromBinding, AuthService, AuthWorkerBinding } from '@dome/auth/client';
import { NotionService, createNotionService } from './notionService'; // Import NotionService

/**
 * Service factory interface
 * This provides a consistent way to access all services
 */
export interface ServiceFactory {
  getConstellationService(env: Bindings): ConstellationClient;
  getAiProcessorService(env: Bindings): AiProcessorClient;
  getSearchService(env: Bindings): SearchService;
  getSiloService(env: Bindings): SiloClient;
  getChatService(env: Bindings): ChatClient;
  getTsunamiService(env: Bindings): TsunamiClient;
  getAuthService(env: Bindings): AuthService;
  getNotionService(env: Bindings): NotionService; // Add NotionService to interface
}

/**
 * Service factory implementation
 * Creates and manages service instances
 */
export class DefaultServiceFactory implements ServiceFactory {
  // We'll use Maps to store service instances by env reference
  private constellationServices: Map<Bindings, ConstellationClient> = new Map();
  private aiProcessorServices: Map<Bindings, AiProcessorClient> = new Map();
  private searchServices: Map<Bindings, SearchService> = new Map();
  private chatServices: Map<Bindings, ChatClient> = new Map();
  private siloServices: Map<Bindings, SiloClient> = new Map();
  private tsunamiServices: Map<Bindings, TsunamiClient> = new Map();
  private authServices: Map<Bindings, AuthService> = new Map();
  private notionServices: Map<Bindings, NotionService> = new Map(); // Add map for NotionService
  private logger = getLogger();

  constructor() {
    this.logger.debug('Service factory initialized');
  }

  /**
   * Get the constellation service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ConstellationService instance
   */
  getConstellationService(env: Bindings): ConstellationClient {
    let service = this.constellationServices.get(env);
    if (!service) {
      this.logger.debug('Creating new ConstellationService instance');
      service = new ConstellationClient(env.CONSTELLATION as unknown as ConstellationBinding);
      this.constellationServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the constellation service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ConstellationService instance
   */
  getAiProcessorService(env: Bindings): AiProcessorClient {
    let service = this.aiProcessorServices.get(env);
    if (!service) {
      this.logger.debug('Creating new ConstellationService instance');
      service = new AiProcessorClient(env.AI_PROCESSOR);
      this.aiProcessorServices.set(env, service);
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
      service = createSiloClient(env.SILO, env.SILO_INGEST_QUEUE as any);
      this.siloServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the chat service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ChatService instance
   */
  getChatService(env: Bindings): ChatClient {
    let service = this.chatServices.get(env);
    if (!service) {
      this.logger.debug('Creating new ChatService instance');
      service = new ChatClient(env.CHAT);
      this.chatServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the tsunami service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns TsunamiClient instance
   */
  getTsunamiService(env: Bindings): TsunamiClient {
    let service = this.tsunamiServices.get(env);
    if (!service) {
      this.logger.debug('Creating new TsunamiClient instance');
      service = new TsunamiClient(env.TSUNAMI);
      this.tsunamiServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the auth service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns AuthService instance
   */
  getAuthService(env: Bindings): AuthService {
    let service = this.authServices.get(env);
    if (!service) {
      this.logger.debug('Creating new AuthService instance');

      // Cast to the appropriate worker binding type, similar to other services
      service = createAuthServiceFromBinding(env.AUTH as unknown as AuthWorkerBinding);

      this.authServices.set(env, service);
    }
    return service;
  }

  /**
   * Get the notion service instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns NotionService instance
   */
  getNotionService(env: Bindings): NotionService {
    let service = this.notionServices.get(env);
    if (!service) {
      this.logger.debug('Creating new NotionService instance');
      // NotionService is created directly, not from a binding like other clients yet
      service = createNotionService(env);
      this.notionServices.set(env, service);
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
