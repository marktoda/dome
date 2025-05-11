import { getLogger } from '@dome/common';
import { ChatController } from './chatController';
import { NotionController } from './notionController';
import { SearchController } from './searchController';
import { SiloController } from './siloController';
import { TsunamiController } from './tsunamiController';
import { ServiceFactory } from '../services/serviceFactory';
import { Bindings } from '../types';

/**
 * Factory for creating controller instances
 */
export class ControllerFactory {
  private logger = getLogger().child({ component: 'ControllerFactory' });
  private chatController: ChatController | null = null;
  private searchController: SearchController | null = null;
  private siloController: SiloController | null = null;
  private tsunamiController: TsunamiController | null = null;
  private notionController: NotionController | null = null;

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
      // const chatService = this.serviceFactory.getChatService(env); // No longer needed for ChatController constructor
      this.chatController = new ChatController();
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
      // SearchController now has a parameterless constructor.
      // It will get its SearchService internally using createServiceFactory() and the env from the request context.
      this.searchController = new SearchController();
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
      // const siloService = this.serviceFactory.getSiloService(env); // No longer needed for SiloController constructor
      // const aiProcessor = this.serviceFactory.getAiProcessorService(env); // No longer needed for SiloController constructor
      this.siloController = new SiloController(); // SiloController now takes no arguments
    }
    return this.siloController;
  }

  /**
   * Get a tsunami controller instance
   * @param env Environment bindings
   * @returns Tsunami controller instance
   */
  getTsunamiController(env: Bindings): TsunamiController {
    if (!this.tsunamiController) {
      this.logger.debug('Creating new TsunamiController instance');
      // const tsunamiService = this.serviceFactory.getTsunamiService(env); // No longer needed for TsunamiController constructor
      this.tsunamiController = new TsunamiController(); // TsunamiController now takes no arguments
    }
    return this.tsunamiController;
  }

  /**
   * Get a notion controller instance
   * @param env Environment bindings
   * @returns Notion controller instance
   */
  getNotionController(env: Bindings): NotionController {
    if (!this.notionController) {
      this.logger.debug('Creating new NotionController instance');
      // NotionController constructor does not take arguments.
      // It will internally use the serviceFactory to get NotionService.
      this.notionController = new NotionController();
    }
    return this.notionController;
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
