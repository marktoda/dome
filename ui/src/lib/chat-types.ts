/**
 * Represents a single source item, often used for citations or references in assistant responses.
 */
export interface SourceItem {
  /** Unique identifier for the source item. */
  id: string;
  /** Display title of the source. */
  title: string;
  /** Identifier for the origin of the source (e.g., 'GitHub', 'Notion', 'Web'). */
  source: string;
  /** Optional URL linking directly to the source content. */
  url?: string;
  /** Relevance score (0-1) indicating how relevant the source is to the query/response. */
  relevanceScore: number;
}

/**
 * Defines the possible senders of a chat message.
 * - `user`: The end-user interacting with the chat.
 * - `assistant`: The AI assistant providing responses.
 * - `system`: Messages originating from the application itself (e.g., errors, notifications).
 */
export type MessageSender = 'user' | 'assistant' | 'system';

/**
 * Base interface containing common properties shared by all chat message types.
 */
export interface BaseChatMessage {
  /** Unique identifier for the message. */
  id: string;
  /** Timestamp when the message was created or received. */
  timestamp: Date;
  /** The sender of the message. */
  sender: MessageSender;
  /** Optional ID of a parent message, used for threading or replies. */
  parentId?: string;
  /** Optional record for storing additional metadata associated with the message. */
  metadata?: Record<string, unknown>; // Use unknown instead of any
}

/**
 * Represents a message sent by the end-user.
 */
export interface UserMessage extends BaseChatMessage {
  sender: 'user';
  /** The text content of the user's message. */
  text: string;
}

/**
 * Represents a standard content message from the assistant, containing the main textual response.
 */
export interface AssistantContentMessage extends BaseChatMessage {
  sender: 'assistant';
  /** Type identifier for content messages. */
  type: 'content';
  /** The textual content of the assistant's response. */
  text: string;
  /** Optional field specifying the format of the text content (e.g., markdown). */
  format?: 'markdown' | 'text';
}

/**
 * Represents an intermediate state where the assistant is processing the user's request.
 * Displayed to provide feedback while waiting for the actual response.
 */
export interface AssistantThinkingMessage extends BaseChatMessage {
  sender: 'assistant';
  /** Type identifier for thinking state messages. */
  type: 'thinking';
  /** Optional text to display during the thinking state (e.g., "Processing..."). */
  text?: string;
}

/**
 * Represents a message specifically containing source information used by the assistant
 * to generate its response. Often follows an {@link AssistantContentMessage}.
 */
export interface AssistantSourcesMessage extends BaseChatMessage {
  sender: 'assistant';
  /** Type identifier for source messages. */
  type: 'sources';
  /** An array of source items relevant to the preceding assistant response. */
  sources: SourceItem[];
}

/**
 * Represents an error message that occurred during chat processing.
 * Can originate from the assistant's internal logic or from the system (e.g., network issues).
 */
export interface AssistantErrorMessage extends BaseChatMessage {
  sender: 'assistant' | 'system';
  /** Type identifier for error messages. */
  type: 'error';
  /** Structured error information. */
  error: {
    /** Detailed error message for logging or debugging. */
    message: string;
    /** Optional error code for categorization (e.g., 'API_TIMEOUT', 'AUTH_ERROR'). */
    code?: string;
    /** Optional record for additional structured error details. */
    details?: Record<string, unknown>; // Use unknown instead of any
  };
  /** Optional user-friendly summary of the error, suitable for display in the UI. */
  text?: string;
}

/**
 * Represents a generic message from the system, not related to errors.
 * Used for informational messages, status updates, welcome prompts, etc.
 */
export interface SystemMessage extends BaseChatMessage {
  sender: 'system';
  /** Type identifier for generic system messages. */
  type: 'system_generic';
  /** The text content of the system message. */
  text: string;
}

/**
 * A union type representing all possible structured message types that can appear
 * in the chat interface's message list. This is the primary type used for storing
 * messages in the `ChatContext`.
 */
export type ParsedMessage =
  | UserMessage
  | AssistantContentMessage
  | AssistantThinkingMessage
  | AssistantSourcesMessage
  | AssistantErrorMessage
  | SystemMessage;

/**
 * Defines the contract for a message parser plugin. These plugins are responsible
 * for interpreting raw data (e.g., from a WebSocket stream or API response)
 * and converting it into a specific, structured `ParsedMessage` type.
 */
export interface MessageParserPlugin {
  /**
   * A unique string identifying the type of message this plugin handles
   * (e.g., 'assistant_content_stream_v1', 'system_error_notification').
   * Useful for logging and debugging the parsing process.
   */
  pluginType: string;

  /**
   * Checks if the provided raw message data is suitable for processing by this plugin.
   * This function should quickly determine if the data structure matches the expected format.
   *
   * @param rawMessage - The raw message data received (could be JSON object, string, etc.).
   * @returns `true` if the plugin recognizes and can handle this message format, `false` otherwise.
   */
  detect: (rawMessage: unknown) => boolean; // Use unknown for raw input

  /**
   * Transforms the raw message data into a structured `ParsedMessage` object.
   * This function is called only if `detect` returns `true`.
   *
   * @param rawMessage - The raw message data validated by `detect`.
   * @param id - A unique identifier to assign to the resulting `ParsedMessage`.
   * @param timestamp - The timestamp to assign to the resulting `ParsedMessage`.
   * @returns A `ParsedMessage` object representing the structured data, or `null` if parsing fails gracefully.
   * @throws An error can be thrown if a critical parsing issue occurs that cannot be handled gracefully.
   */
  parse: (rawMessage: unknown, id: string, timestamp: Date) => ParsedMessage | null; // Use unknown for raw input
}


/**
 * Defines the structure of the context value provided by `ChatProvider`.
 * It includes the current state of the chat and functions to modify that state.
 */
export type ChatContextType = {
  /** An array containing all messages currently displayed in the chat, ordered chronologically. */
  messages: ParsedMessage[];
  /**
   * Adds a new message to the chat history. If the sender is 'user',
   * it also initiates the process of sending the message to the backend API.
   *
   * @param text - The textual content of the message.
   * @param sender - The originator of the message ('user', 'assistant', or 'system'). Defaults to 'user'.
   * @returns A promise that resolves once the message has been added locally and, if applicable, the backend call has been initiated.
   */
  addMessage: (text: string, sender?: MessageSender) => Promise<void>;
  /** A boolean flag indicating if the chat is currently waiting for a response from the assistant/backend. */
  isLoading: boolean;
  /** Holds the most recent error message object (`AssistantErrorMessage`) if an error occurred, otherwise `null`. */
  error: AssistantErrorMessage | null;
  /** A function to clear all messages from the chat history and reset the error state. */
  clearChat: () => void;
};

/**
 * Illustrative example of a potential raw message structure received from a backend
 * (e.g., via WebSocket). The actual structure will depend on the specific API design.
 * `MessageParserPlugin` implementations would be responsible for converting objects
 * like this into the appropriate `ParsedMessage` types.
 */
export interface RawAssistantMessagePayload {
  /** Optional ID assigned by the backend. */
  id?: string;
  /** Identifier for the type of payload (e.g., 'content_chunk', 'sources', 'error', 'status_update'). */
  type: string;
  /** Sender, typically 'assistant' or 'system'. */
  sender?: MessageSender;
  /** Text content, potentially partial if streaming. */
  text?: string;
  /** Format hint for the text content. */
  format?: 'markdown' | 'text';
  /** Array of source items, if applicable to this payload type. */
  sources?: SourceItem[];
  /** Optional parent message ID for threading. */
  parentId?: string;
  /** Error details if payload type indicates an error. */
  error?: {
    message: string;
    code?: string;
    details?: unknown; // Use unknown
  };
  /** Optional metadata. */
  metadata?: Record<string, unknown>; // Use unknown
  /** Flag indicating the end of a streamed response. */
  isFinal?: boolean;
  // ... other fields specific to the backend protocol might exist
}
