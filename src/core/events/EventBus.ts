import { NoteEvent, NoteEventType, EventMap, EventHandler } from './types.js';
import logger from '../utils/logger.js';

type HandlerInfo = {
  name: string;
  handler: EventHandler<any>;
};

export class EventBus {
  private handlers = new Map<NoteEventType, Set<HandlerInfo>>();
  private processingFlags = new Map<string, boolean>();

  on<T extends NoteEventType>(
    eventType: T,
    handler: EventHandler<EventMap[T]>,
    name?: string
  ): () => void {
    const handlerInfo: HandlerInfo = {
      name: name || handler.name || 'anonymous',
      handler
    };

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    
    this.handlers.get(eventType)!.add(handlerInfo);
    logger.info(`Registered handler "${handlerInfo.name}" for ${eventType}`);

    // Return unsubscribe function
    return () => this.off(eventType, handlerInfo);
  }

  off(eventType: NoteEventType, handlerInfo: HandlerInfo): void {
    this.handlers.get(eventType)?.delete(handlerInfo);
    logger.debug(`Unregistered handler "${handlerInfo.name}" from ${eventType}`);
  }

  async emit<T extends NoteEvent>(event: T): Promise<void> {
    const eventKey = `${event.type}:${event.noteId}`;
    
    // Prevent recursive emissions for the same note
    if (this.processingFlags.get(eventKey)) {
      logger.warn(`Preventing recursive emission for ${eventKey}`);
      return;
    }

    this.processingFlags.set(eventKey, true);
    
    try {
      const handlers = this.handlers.get(event.type) || new Set();
      
      if (handlers.size === 0) {
        logger.debug(`No handlers for ${event.type}`);
        return;
      }

      logger.debug(`Emitting ${event.type} for ${event.noteId} to ${handlers.size} handler(s)`);

      // Run handlers in parallel but isolated from each other
      const results = await Promise.allSettled(
        Array.from(handlers).map(async ({ name, handler }) => {
          const startTime = Date.now();
          try {
            await handler(event);
            const duration = Date.now() - startTime;
            logger.debug(`✓ Handler "${name}" completed in ${duration}ms`);
          } catch (error) {
            const duration = Date.now() - startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`✗ Handler "${name}" failed after ${duration}ms: ${errorMsg}`);
            // Don't throw - let other handlers continue
          }
        })
      );

      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        logger.warn(`${failed}/${handlers.size} handlers failed for ${event.type}`);
      }
    } finally {
      this.processingFlags.delete(eventKey);
    }
  }

  getHandlerCount(eventType?: NoteEventType): number {
    if (eventType) {
      return this.handlers.get(eventType)?.size || 0;
    }
    let total = 0;
    this.handlers.forEach(set => total += set.size);
    return total;
  }

  clear(): void {
    this.handlers.clear();
    this.processingFlags.clear();
  }
}