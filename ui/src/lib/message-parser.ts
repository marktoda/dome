import { v4 as uuidv4 } from 'uuid';
import {
  ParsedMessage,
  MessageParserPlugin,
  UserMessage,
  AssistantContentMessage,
  AssistantThinkingMessage,
  AssistantSourcesMessage,
  AssistantReasoningMessage, // Import the new type
  AssistantErrorMessage,
  SystemMessage,
  RawAssistantMessagePayload, // Keep for type assertions within parse methods
  SourceItem,
  MessageSender,
} from './chat-types';

/**
 * @fileoverview Message parsing service and plugins for the chat UI.
 * This file defines a plugin-based architecture for parsing various raw message
 * formats into structured ParsedMessage objects.
 */

/**
 * Default User Message Plugin
 * Handles messages explicitly marked or inferred as from the user.
 */
class UserMessagePlugin implements MessageParserPlugin {
  pluginType = 'user_text_v1';

  /**
   * Detects if the raw message is a user message.
   * @param rawMessage - The raw message data.
   * @returns True if it's a string (assumed user input) or an object with sender 'user'.
   */
  detect(rawMessage: unknown): boolean {
    // User messages should be objects with sender: 'user'.
    // Raw strings from WebSocket are not user messages.
    return !!rawMessage && typeof rawMessage === 'object' && 'sender' in rawMessage && rawMessage.sender === 'user' && 'text' in rawMessage && typeof rawMessage.text === 'string';
  }

  /**
   * Parses the raw message into a UserMessage.
   * @param rawMessage - The raw message data (validated by detect).
   * @param id - The ID for the message.
   * @param timestamp - The timestamp for the message.
   * @returns A UserMessage object or null if parsing fails.
   */
  parse(rawMessage: unknown, id: string, timestamp: Date): UserMessage | null {
    // Type assertion is safe here because detect() passed.
    // The `msg` variable was redundant.
    const userMsgData = rawMessage as { id?: string; timestamp?: string | number | Date; sender: 'user'; text: string; parentId?: string; metadata?: Record<string, unknown> };

    return {
      id: userMsgData.id || id,
      timestamp: userMsgData.timestamp ? new Date(userMsgData.timestamp) : timestamp,
      sender: 'user',
      text: userMsgData.text,
      parentId: userMsgData.parentId,
      metadata: userMsgData.metadata,
    };
    // No need for console.warn or returning null if detect guarantees the structure
  }
}


/**
 * Assistant Reasoning Message Plugin
 * Handles messages containing intermediate reasoning steps from the assistant.
 */
class AssistantReasoningPlugin implements MessageParserPlugin {
  pluginType = 'assistant_reasoning_v1';

  detect(rawMessage: unknown): boolean {
    if (typeof rawMessage === 'string') {
      try {
        const parsed = JSON.parse(rawMessage);
        // Check for the specific structure with 'reasoning' field
        return typeof parsed === 'object' && parsed !== null && typeof parsed.reasoning === 'string' && parsed.reasoning.trim() !== '';
      } catch (e) {
        return false; // Not valid JSON
      }
    }
    // Also handle if the raw message is already an object with reasoning
    if (typeof rawMessage === 'object' && rawMessage !== null && 'reasoning' in rawMessage && typeof (rawMessage as any).reasoning === 'string' && (rawMessage as any).reasoning.trim() !== '') {
        return true;
    }
    return false;
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): AssistantReasoningMessage | null {
    try {
      let parsed: any;
      if (typeof rawMessage === 'string') {
         parsed = JSON.parse(rawMessage); // Safe due to detect()
      } else if (typeof rawMessage === 'object' && rawMessage !== null) {
         parsed = rawMessage; // Already an object
      } else {
         throw new Error("Invalid rawMessage type for reasoning plugin");
      }

      // Extract reasoning text
      const reasoningText = parsed.reasoning as string;

      return {
        id, // Use the currentAssistantMessageIdRef.current passed as `id`
        timestamp,
        sender: 'assistant',
        type: 'reasoning',
        text: reasoningText,
      };
    } catch (error) {
      console.error('[AssistantReasoningPlugin] Error parsing reasoning message:', error, 'Raw:', rawMessage);
      return null; // Parsing failed
    }
  }
}

/**
 * LangGraph Stream Plugin
 * Handles raw string chunks that are part of LangGraph's streaming format.
 * This needs to be placed before generic string handlers or fallback content handlers.
 */
class LangGraphStreamPlugin implements MessageParserPlugin {
  pluginType = 'langgraph_stream_v1';

  detect(rawMessage: unknown): boolean {
    // Detects if the raw message is a string and looks like a LangGraph stream event.
    // LangGraph events are often JSON arrays or objects serialized as strings.
    if (typeof rawMessage === 'string') {
      const trimmed = rawMessage.trim();
      // Be more specific for LangGraph stream events based on observed patterns
      return trimmed.startsWith('["messages",') || trimmed.startsWith('["updates",');
    }
    return false;
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): ParsedMessage | null {
    const rawString = rawMessage as string; // Safe due to detect()

    // Attempt to parse the string as JSON.
    // LangGraph streams can be complex; this is a simplified interpretation.
    // A more robust solution would involve a stateful parser or more specific event types.
    try {
      const parsedEvent = JSON.parse(rawString);

      // Example: Handling a common LangGraph "chunk" or "stream" event structure
      // This is highly dependent on how your LangGraph application formats its output.
      // The following is a placeholder for actual LangGraph event parsing logic.
      //
      // If it's an array like ["event_type", payload]
      if (Array.isArray(parsedEvent) && parsedEvent.length > 0) {
        const eventType = parsedEvent[0];
        const payload = parsedEvent[1];

        if (eventType === 'messages' && Array.isArray(payload) && payload.length > 0 && payload[0]?.kwargs?.content && typeof payload[0].kwargs.content === 'string') {
          return {
            id,
            timestamp,
            sender: 'assistant',
            type: 'content',
            text: payload[0].kwargs.content,
            format: 'markdown',
          };
        }
        // Placeholder for handling "updates" or other LangGraph event types
        if (eventType === 'updates') {
           console.log('[LangGraphStreamPlugin] Received "updates" event, specific parsing logic needed:', payload);
           // Example: if (payload.some_thinking_indicator) return { id, timestamp, sender: 'assistant', type: 'thinking', text: '...' };
           // Example: if (payload.some_sources_indicator) return { id, timestamp, sender: 'assistant', type: 'sources', sources: [...] };
           return null; // Let other plugins handle or ignore if not a displayable message
        }
      }
      // If JSON but not a recognized LangGraph array structure, log and let fall through
      console.warn('[LangGraphStreamPlugin] Parsed LangGraph string, but not a recognized array event:', parsedEvent);
    } catch (e) {
      // Not JSON, could be a direct string chunk from assistant (less common for LangGraph but possible)
      console.warn('[LangGraphStreamPlugin] Failed to parse as JSON, treating as raw assistant text:', rawString);
      return {
        id,
        timestamp,
        sender: 'assistant',
        type: 'content',
        text: rawString,
        format: 'text',
      };
    }
    return null; // Fall through if not handled
  }
}


/**
 * Assistant Content Message Plugin
 * Handles standard content messages from the assistant.
 * This is the CORRECT version. The duplicated one above this (if any) should be removed by this diff.
 */
class AssistantContentPlugin implements MessageParserPlugin {
  pluginType = 'assistant_content_v1';

  detect(rawMessage: unknown): boolean {
    const msg = rawMessage as Partial<RawAssistantMessagePayload>;
    return !!msg && msg.sender === 'assistant' && msg.type === 'content' && typeof msg.text === 'string';
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): AssistantContentMessage | null {
    // Type assertion safe after detect()
    const msg = rawMessage as RawAssistantMessagePayload;
    return {
      id: msg.id || id,
      timestamp,
      sender: 'assistant',
      type: 'content',
      text: msg.text!, // Non-null assertion safe due to detect()
      format: msg.format === 'markdown' || msg.format === 'text' ? msg.format : 'markdown',
      parentId: msg.parentId,
      metadata: msg.metadata,
    };
  }
}

/**
 * Assistant Thinking Message Plugin
 * Handles messages indicating the assistant is currently processing.
 */
class AssistantThinkingPlugin implements MessageParserPlugin {
  pluginType = 'assistant_thinking_v1';

  detect(rawMessage: unknown): boolean {
    const msg = rawMessage as Partial<RawAssistantMessagePayload>;
    return !!msg && msg.sender === 'assistant' && msg.type === 'thinking';
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): AssistantThinkingMessage | null {
    // Type assertion safe after detect()
    const msg = rawMessage as RawAssistantMessagePayload;
    return {
      id: msg.id || id,
      timestamp,
      sender: 'assistant',
      type: 'thinking',
      text: typeof msg.text === 'string' ? msg.text : undefined,
      parentId: msg.parentId,
      metadata: msg.metadata,
    };
  }
}

/**
 * Assistant Sources Message Plugin
 * Handles messages providing source/citation information.
 */
class AssistantSourcesPlugin implements MessageParserPlugin {
  pluginType = 'assistant_sources_v1';

  detect(rawMessage: unknown): boolean {
    const msg = rawMessage as Partial<RawAssistantMessagePayload>;
    return !!msg && msg.sender === 'assistant' && msg.type === 'sources' && Array.isArray(msg.sources);
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): AssistantSourcesMessage | null {
    // Type assertion safe after detect()
    const msg = rawMessage as RawAssistantMessagePayload;
    // Basic validation for source items
    const sources = (msg.sources || []).filter(
      (s: any): s is SourceItem =>
        s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.source === 'string' && typeof s.relevanceScore === 'number'
    );
    return {
      id: msg.id || id,
      timestamp,
      sender: 'assistant',
      type: 'sources',
      sources,
      parentId: msg.parentId,
      metadata: msg.metadata,
    };
  }
}

/**
 * Assistant Error Message Plugin
 * Handles error messages from the assistant or system.
 */
class AssistantErrorPlugin implements MessageParserPlugin {
  pluginType = 'assistant_error_v1';

  detect(rawMessage: unknown): boolean {
    const msg = rawMessage as Partial<RawAssistantMessagePayload>;
    return !!msg &&
           (msg.sender === 'assistant' || msg.sender === 'system') &&
           msg.type === 'error' &&
           !!msg.error &&
           typeof msg.error.message === 'string';
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): AssistantErrorMessage | null {
    // Type assertion safe after detect()
    const msg = rawMessage as RawAssistantMessagePayload;
    // Safely handle details assignment
    let details: Record<string, unknown> | undefined = undefined;
    if (msg.error?.details && typeof msg.error.details === 'object' && msg.error.details !== null) {
        details = msg.error.details as Record<string, unknown>;
    }

    return {
      id: msg.id || id,
      timestamp,
      sender: msg.sender as 'assistant' | 'system', // Safe cast due to detect()
      type: 'error',
      error: {
        message: msg.error!.message, // Non-null assertion safe due to detect()
        code: typeof msg.error!.code === 'string' ? msg.error!.code : undefined,
        details: details,
      },
      text: typeof msg.text === 'string' ? msg.text : undefined,
      parentId: msg.parentId,
      metadata: msg.metadata,
    };
  }
}

/**
 * System Message Plugin
 * Handles generic system messages (notifications, status updates).
 */
class SystemMessagePlugin implements MessageParserPlugin {
  pluginType = 'system_generic_v1';

  detect(rawMessage: unknown): boolean {
    const msg = rawMessage as Partial<RawAssistantMessagePayload>; // Use partial type for safety
    return !!msg && msg.sender === 'system' && msg.type === 'system_generic' && typeof msg.text === 'string';
  }

  
    parse(rawMessage: unknown, id: string, timestamp: Date): SystemMessage | null {
      // Type assertion to a structure known to have the detected fields
      const msg = rawMessage as { id?: string; text: string; parentId?: string; metadata?: Record<string, unknown> };
      return {
        id: msg.id || id,
        timestamp: timestamp, // Use the timestamp passed into the function
        sender: 'system',
        type: 'system_generic',
        text: msg.text, // Already checked in detect
        parentId: msg.parentId,
        metadata: msg.metadata,
      };
    }
  }
/**
 * Fallback Plugin for unknown assistant messages with text.
 * Attempts to parse as a basic content message.
 */
class FallbackAssistantContentPlugin implements MessageParserPlugin {
  pluginType = 'fallback_assistant_content_v1';

  detect(rawMessage: unknown): boolean {
    const msg = rawMessage as Partial<RawAssistantMessagePayload>;
    // Detect if it's from assistant, has text, but lacks a recognized 'type' or has an unknown 'type'
    return !!msg && msg.sender === 'assistant' && typeof msg.text === 'string' &&
           (msg.type === undefined || !['content', 'thinking', 'sources', 'error'].includes(msg.type));
  }

  parse(rawMessage: unknown, id: string, timestamp: Date): AssistantContentMessage | null {
    // Type assertion safe after detect()
    const msg = rawMessage as RawAssistantMessagePayload;
    console.warn(`[FallbackAssistantContentPlugin] Parsing message with unknown or missing type "${msg.type}" as content:`, msg);
    return {
      id: msg.id || id,
      timestamp,
      sender: 'assistant',
      type: 'content', // Assume 'content'
      text: msg.text!, // Non-null assertion safe due to detect()
      format: 'markdown', // Default format
      parentId: msg.parentId,
      metadata: msg.metadata,
    };
  }
}


/**
 * Service for processing raw messages using a chain of parser plugins.
 */
export class MessageProcessingService {
  private plugins: MessageParserPlugin[];

  /**
   * Initializes the service with a default set of plugins or custom ones.
   * @param customPlugins - Optional array of custom plugins to use instead of defaults.
   */
  constructor(customPlugins?: MessageParserPlugin[]) {
    // Default plugins order: Specific types first, then fallback.
    this.plugins = customPlugins || [
      new AssistantReasoningPlugin(), // Handle reasoning first
      new LangGraphStreamPlugin(),
      new UserMessagePlugin(),
      new AssistantContentPlugin(),
      new AssistantThinkingPlugin(),
      new AssistantSourcesPlugin(),
      new AssistantErrorPlugin(),
      new SystemMessagePlugin(),
      new FallbackAssistantContentPlugin(), // Last resort for assistant messages with text
    ];
  }

  /**
   * Registers a new parser plugin.
   * @param plugin - The plugin to register.
   * @param highPriority - If true, adds the plugin to the beginning of the chain.
   */
  registerPlugin(plugin: MessageParserPlugin, highPriority: boolean = false): void {
    if (highPriority) {
      this.plugins.unshift(plugin);
    } else {
      this.plugins.push(plugin);
    }
    console.log(`[MessageProcessingService] Registered plugin: ${plugin.pluginType}`);
  }

  /**
   * Creates a fallback error message for parsing failures.
   * @param errorMessage - The error message string.
   * @param id - The ID for the message.
   * @param timestamp - The timestamp for the message.
   * @param sender - The sender of the error ('system' or 'assistant').
   * @returns An AssistantErrorMessage object.
   */
  private createFallbackError(
    errorMessage: string,
    id: string,
    timestamp: Date,
    sender: 'assistant' | 'system' = 'system'
  ): AssistantErrorMessage {
    return {
      id,
      timestamp,
      sender,
      type: 'error',
      error: {
        message: errorMessage,
        code: 'PARSING_FAILURE',
      },
      text: `System Error: ${errorMessage}`,
    };
  }

  /**
   * Parses a raw message into a structured ParsedMessage using registered plugins.
   * @param rawMessage - The raw message data.
   * @param messageId - Optional ID; defaults to a new UUID.
   * @param messageTimestamp - Optional timestamp; defaults to now.
   * @returns A ParsedMessage object, a fallback error message, or null if no plugin handles it.
   */
  parseMessage(
    rawMessage: unknown, // Accept unknown type
    messageId?: string,
    messageTimestamp?: Date,
  ): ParsedMessage | null {
    const id = messageId || uuidv4();
    const timestamp = messageTimestamp || new Date();

    if (rawMessage === null || typeof rawMessage === 'undefined') {
      console.warn('[MessageProcessingService] Received null or undefined raw message.');
      return this.createFallbackError('Received empty message data.', id, timestamp);
    }

    for (const plugin of this.plugins) {
      try {
        // Detect first using the unknown type
        if (plugin.detect(rawMessage)) {
          // If detected, parse (plugin internally handles 'unknown' or asserts type)
          const parsed = plugin.parse(rawMessage, id, timestamp);
          if (parsed) {
            // Basic validation
            if (!parsed.id || !parsed.timestamp || !parsed.sender) {
                console.error(`[MessageProcessingService] Plugin ${plugin.pluginType} produced an invalid message (missing core fields):`, parsed, 'Raw message:', rawMessage);
                return this.createFallbackError(
                    `Plugin ${plugin.pluginType} produced an invalid message structure.`,
                    id, timestamp
                );
            }
            return parsed;
          }
          // If parse returns null explicitly, let it fall through to the next plugin or final warning
        }
      } catch (error: any) {
        console.error(`[MessageProcessingService] Error in plugin ${plugin.pluginType} while parsing:`, error, 'Raw message:', rawMessage);
        return this.createFallbackError(
          `Plugin ${plugin.pluginType} encountered an error: ${error.message || 'Unknown error'}.`,
          id, timestamp
        );
      }
    }

    console.warn('[MessageProcessingService] No plugin could handle raw message:', rawMessage);
    // Optionally return a generic error or null if unhandled messages are acceptable
    // return this.createFallbackError('Unknown message format received.', id, timestamp);
    return null; // Return null if no plugin specifically handled it and no error occurred
  }
}

// Export a default instance for easy use
export const messageProcessingService = new MessageProcessingService();