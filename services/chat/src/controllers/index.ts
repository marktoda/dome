import { getLogger } from '@dome/logging';
import { Services } from '../services';
import { ChatController, createChatController } from './chatController';
import { AdminController, createAdminController } from './adminController';

/**
 * Controllers container interface
 */
export interface Controllers {
  chat: ChatController;
  admin: AdminController;
}

/**
 * Create and initialize all controllers
 * @param env Environment bindings
 * @param services Service container
 * @returns Controllers container
 */
export function createControllers(env: Env, services: Services, ctx: ExecutionContext): Controllers {
  const logger = getLogger().child({ component: 'ControllerFactory' });
  logger.info('Initializing chat orchestrator controllers');

  return {
    chat: createChatController(env, services, ctx),
    admin: createAdminController(env, services),
  };
}

// Export controller types
export { ChatController } from './chatController';
export { AdminController } from './adminController';
