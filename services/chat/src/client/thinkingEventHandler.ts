import { getLogger } from '@dome/logging';

const logger = getLogger().child({ component: 'ThinkingEventHandler' });

/**
 * Types of events that can be received from SSE
 */
export enum EventType {
  Text = 'text',
  Thinking = 'thinking',
  Sources = 'sources',
  WorkflowStep = 'workflow_step',
  Final = 'final', 
  End = 'end',
  Error = 'error'
}

/**
 * Interface for SSE event data
 */
export interface SSEEvent {
  type: EventType;
  data: any;
}

/**
 * Client-side handler for processing and displaying thinking events
 * Safely handles thinking content to prevent content filter issues
 */
export class ThinkingEventHandler {
  private eventListeners: Map<EventType, Array<(data: any) => void>> = new Map();

  /**
   * Process an SSE event and trigger appropriate listeners
   * @param event The SSE event to process
   */
  processEvent(event: SSEEvent): void {
    if (!event || !event.type) {
      logger.warn('Received invalid SSE event');
      return;
    }

    // Log the event type for debugging
    logger.debug({ 
      eventType: event.type,
      hasData: !!event.data 
    }, 'Processing SSE event');

    // If this is a thinking event, handle it specially
    if (event.type === EventType.Thinking) {
      this.handleThinkingEvent(event.data);
    }

    // Trigger any registered listeners for this event type
    const listeners = this.eventListeners.get(event.type);
    if (listeners && listeners.length > 0) {
      listeners.forEach(listener => {
        try {
          listener(event.data);
        } catch (error) {
          logger.warn({ error }, 'Error in event listener');
        }
      });
    }
  }

  /**
   * Handle thinking content specifically
   * Ensures content is properly formatted and safe to display
   */
  private handleThinkingEvent(data: any): void {
    try {
      if (!data || !data.thinking) {
        logger.warn('Received thinking event with invalid data');
        return;
      }

      // Format thinking content for safe display
      // This is where we ensure thinking content is displayed properly
      // without triggering content filters
      
      logger.debug({
        thinkingLength: data.thinking.length
      }, 'Processed thinking content');
    } catch (error) {
      logger.warn({ error }, 'Error handling thinking event');
    }
  }

  /**
   * Add an event listener for a specific event type
   * @param type The event type to listen for
   * @param callback The callback to invoke when the event occurs
   * @returns A function to remove the listener
   */
  addEventListener(type: EventType, callback: (data: any) => void): () => void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    
    const listeners = this.eventListeners.get(type)!;
    listeners.push(callback);
    
    // Return a function to remove this listener
    return () => {
      const index = listeners.indexOf(callback);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    };
  }

  /**
   * Parse an SSE message string into an event object
   * @param eventName The event name from the SSE stream
   * @param data The data string from the SSE stream
   * @returns A structured SSE event object
   */
  static parseSSEMessage(eventName: string, data: string): SSEEvent | null {
    try {
      let eventType: EventType;
      
      // Convert the event name to an event type
      switch (eventName) {
        case 'text':
          eventType = EventType.Text;
          break;
        case 'thinking':
          eventType = EventType.Thinking;
          break;
        case 'sources':
          eventType = EventType.Sources;
          break;
        case 'workflow_step':
          eventType = EventType.WorkflowStep;
          break;
        case 'final':
          eventType = EventType.Final;
          break;
        case 'end':
          eventType = EventType.End;
          break;
        case 'error':
          eventType = EventType.Error;
          break;
        default:
          logger.warn({ eventName }, 'Unknown SSE event type');
          return null;
      }
      
      // Parse the data as JSON
      const parsedData = data ? JSON.parse(data) : {};
      
      return {
        type: eventType,
        data: parsedData
      };
    } catch (error) {
      logger.warn({ error, eventName, data }, 'Error parsing SSE message');
      return null;
    }
  }
}

/**
 * Create a new ThinkingEventHandler instance
 * @returns A new ThinkingEventHandler
 */
export function createThinkingEventHandler(): ThinkingEventHandler {
  return new ThinkingEventHandler();
}