import { Bindings } from '../types';
import { getLogger } from '@dome/logging';
import { ServiceFactory } from '../services/serviceFactory';
import { SearchController } from './searchController';
import { ChatController } from './chatController';
import { SiloController } from './siloController';

/**
 * Controller factory interface
 * This provides a consistent way to access all controllers
 */
export interface ControllerFactory {
  getSearchController(env: Bindings): SearchController;
  getChatController(env: Bindings): ChatController;
  getSiloController(env: Bindings): SiloController;
}

/**
 * Controller factory implementation
 * Creates and manages controller instances with their service dependencies
 */
export class DefaultControllerFactory implements ControllerFactory {
  // We'll use Maps to store controller instances by env reference
  private searchControllers: Map<Bindings, SearchController> = new Map();
  private chatControllers: Map<Bindings, ChatController> = new Map();
  private siloControllers: Map<Bindings, SiloController> = new Map();
  private logger = getLogger();
  private serviceFactory: ServiceFactory;

  constructor(serviceFactory: ServiceFactory) {
    this.serviceFactory = serviceFactory;
    this.logger.debug('Controller factory initialized');
  }

  /**
   * Get the search controller instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns SearchController instance
   */
  getSearchController(env: Bindings): SearchController {
    let controller = this.searchControllers.get(env);
    if (!controller) {
      this.logger.debug('Creating new SearchController instance');
      controller = new SearchController(this.serviceFactory.getSearchService(env));
      this.searchControllers.set(env, controller);
    }
    return controller;
  }

  /**
   * Get the chat controller instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns ChatController instance
   */
  getChatController(env: Bindings): ChatController {
    let controller = this.chatControllers.get(env);
    if (!controller) {
      this.logger.debug('Creating new ChatController instance');
      controller = new ChatController(this.serviceFactory.getChatService(env));
      this.chatControllers.set(env, controller);
    }
    return controller;
  }

  /**
   * Get the silo controller instance for a specific env
   * @param env Cloudflare Workers environment bindings
   * @returns SiloController instance
   */
  getSiloController(env: Bindings): SiloController {
    let controller = this.siloControllers.get(env);
    if (!controller) {
      this.logger.debug('Creating new SiloController instance');
      controller = new SiloController(env);
      this.siloControllers.set(env, controller);
    }
    return controller;
  }
}

/**
 * Create a controller factory instance
 * @param serviceFactory Service factory instance
 * @returns ControllerFactory instance
 */
export function createControllerFactory(serviceFactory: ServiceFactory): ControllerFactory {
  return new DefaultControllerFactory(serviceFactory);
}
