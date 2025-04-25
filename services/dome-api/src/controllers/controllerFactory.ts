import { getLogger } from '@dome/logging';
import { ChatController } from './chatController';
import { SearchController } from './searchController';
import { SiloController } from './siloController';
import { ChatService } from '../services/chatService';
import { SearchService } from '../services/searchService';
import { Bindings } from '../types';
import { ServiceFactory } from '../services/serviceFactory';

/**
 * Factory for creating controller instances
 */
export class ControllerFactory {
  private logger = getLogger().child({ component: 'ControllerFactory' });
  private chatController: ChatController | null = null;
  private searchController: SearchController | null = null;
  private siloController: SiloController | null = null;

  /**
   * Create a new controller factory
   * @param serviceFactory Service factory instance
   */
  constructor(private serviceFactory: ServiceFactory) {
    this.logger.debug('Creating new ControllerFactory instance');
  }

  /**
   * Get a chat controller instance
   * @param env Environment bindings
   * @returns Chat controller instance
   */
  getChatController(env: Bindings): ChatController {
    if (!this.chatController) {
      this.logger.debug('Creating new ChatController instance');
      const chatService = new ChatService(env);
      this.chatController = new ChatController(chatService);
    }
    return this.chatController;
  }

  /**
   * Get a search controller instance
   * @param env Environment bindings
   * @returns Search controller instance
   */
  getSearchController(env: Bindings): SearchController {
    if (!this.searchController) {
      this.logger.debug('Creating new SearchController instance');
      const searchService = this.serviceFactory.getSearchService(env);
      this.searchController = new SearchController(searchService);
    }
    return this.searchController;
  }

  /**
   * Get a silo controller instance
   * @param env Environment bindings
   * @returns Silo controller instance
   */
  getSiloController(env: Bindings): SiloController {
    if (!this.siloController) {
      this.logger.debug('Creating new SiloController instance');
      const siloService = this.serviceFactory.getSiloService(env);
      this.siloController = new SiloController(siloService);
    }
    return this.siloController;
  }

}

/**
 * Create a controller factory
 * @param serviceFactory Service factory instance
 * @returns Controller factory instance
 */
export function createControllerFactory(serviceFactory: ServiceFactory): ControllerFactory {
  return new ControllerFactory(serviceFactory);
}
