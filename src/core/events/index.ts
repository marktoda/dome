import { EventBus } from './EventBus.js';
import { NoteEventType } from './types.js';
import { handleVectorEmbed } from './handlers/vectorEmbed.js';
import { handleTodoExtraction, handleTodoRemoval } from './handlers/todoExtractor.js';
import logger from '../utils/logger.js';

export { EventBus } from './EventBus.js';
export * from './types.js';

export interface EventBusConfig {
  enableVectorEmbed?: boolean;
  enableTodoExtraction?: boolean;
}

/**
 * Create a no-op EventBus that doesn't emit any events.
 * Useful for CLI commands and tests that don't need event handling.
 */
export function createNoOpEventBus(): EventBus {
  return new EventBus();
}

/**
 * Create a configured EventBus with registered handlers.
 * Each call creates a new, independent EventBus instance.
 */
export function createEventBus(config?: EventBusConfig): EventBus {
  const {
    enableVectorEmbed = true,
    enableTodoExtraction = true
  } = config || {};

  const eventBus = new EventBus();

  logger.info('Creating new EventBus with handlers...');

  // Vector embedding handler
  if (enableVectorEmbed) {
    eventBus.on(NoteEventType.NoteCreated, handleVectorEmbed, 'vectorEmbed');
    eventBus.on(NoteEventType.NoteUpdated, handleVectorEmbed, 'vectorEmbed');
  }

  // TODO extraction handlers
  if (enableTodoExtraction) {
    eventBus.on(NoteEventType.NoteCreated, handleTodoExtraction, 'todoExtractor');
    eventBus.on(NoteEventType.NoteUpdated, handleTodoExtraction, 'todoExtractor');
    eventBus.on(NoteEventType.NoteRemoved, handleTodoRemoval, 'todoRemoval');
  }

  const totalHandlers = eventBus.getHandlerCount();
  logger.info(`EventBus created with ${totalHandlers} handler(s)`);

  return eventBus;
}
