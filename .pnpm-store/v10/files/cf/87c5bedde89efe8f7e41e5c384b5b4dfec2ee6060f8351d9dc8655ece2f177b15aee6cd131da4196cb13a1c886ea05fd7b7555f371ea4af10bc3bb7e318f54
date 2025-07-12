/**
 * Base interface for identifying JSON-RPC messages.
 */
interface JSONRPCMessageIdentifier {
    /**
     * Request identifier. Can be a string, number, or null.
     * Responses must have the same ID as the request they relate to.
     * Notifications (requests without an expected response) should omit the ID or use null.
     */
    id?: number | string | null;
}
/**
 * Base interface for all JSON-RPC messages (Requests and Responses).
 */
interface JSONRPCMessage extends JSONRPCMessageIdentifier {
    /**
     * Specifies the JSON-RPC version. Must be "2.0".
     * @default "2.0"
     * @const "2.0"
     */
    jsonrpc?: '2.0';
}
/**
 * Represents a JSON-RPC request object base structure.
 * Specific request types should extend this.
 */
interface JSONRPCRequest extends JSONRPCMessage {
    /**
     * The name of the method to be invoked.
     */
    method: string;
    /**
     * Parameters for the method. Can be a structured object, an array, or null/omitted.
     * Specific request interfaces will define the exact type.
     * @default null
     */
    params?: unknown;
}
/**
 * Represents a JSON-RPC error object.
 */
interface JSONRPCError<Data = unknown | null, Code = number> {
    /**
     * A number indicating the error type that occurred.
     */
    code: Code;
    /**
     * A string providing a short description of the error.
     */
    message: string;
    /**
     * Optional additional data about the error.
     * @default null
     */
    data?: Data;
}
/**
 * Represents a JSON-RPC response object.
 */
interface JSONRPCResponse<R = unknown | null, E = unknown | null> extends JSONRPCMessage {
    /**
     * The result of the method invocation. Required on success.
     * Should be null or omitted if an error occurred.
     * @default null
     */
    result?: R;
    /**
     * An error object if an error occurred during the request. Required on failure.
     * Should be null or omitted if the request was successful.
     * @default null
     */
    error?: JSONRPCError<E> | null;
}
/**
 * Represents the state of a task within the A2A protocol.
 * @description An enumeration.
 */
type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'unknown';
/**
 * Defines the authentication schemes and credentials for an agent.
 */
interface AgentAuthentication {
    /**
     * List of supported authentication schemes.
     */
    schemes: string[];
    /**
     * Credentials for authentication. Can be a string (e.g., token) or null if not required initially.
     * @default null
     */
    credentials?: string | null;
}
/**
 * Describes the capabilities of an agent.
 */
interface AgentCapabilities {
    /**
     * Indicates if the agent supports streaming responses.
     * @default false
     */
    streaming?: boolean;
    /**
     * Indicates if the agent supports push notification mechanisms.
     * @default false
     */
    pushNotifications?: boolean;
    /**
     * Indicates if the agent supports providing state transition history.
     * @default false
     */
    stateTransitionHistory?: boolean;
}
/**
 * Represents the provider or organization behind an agent.
 */
interface AgentProvider {
    /**
     * The name of the organization providing the agent.
     */
    organization: string;
    /**
     * URL associated with the agent provider.
     * @default null
     */
    url?: string | null;
}
/**
 * Defines a specific skill or capability offered by an agent.
 */
interface AgentSkill {
    /**
     * Unique identifier for the skill.
     */
    id: string;
    /**
     * Human-readable name of the skill.
     */
    name: string;
    /**
     * Optional description of the skill.
     * @default null
     */
    description?: string | null;
    /**
     * Optional list of tags associated with the skill for categorization.
     * @default null
     */
    tags?: string[] | null;
    /**
     * Optional list of example inputs or use cases for the skill.
     * @default null
     */
    examples?: string[] | null;
    /**
     * Optional list of input modes supported by this skill, overriding agent defaults.
     * @default null
     */
    inputModes?: string[] | null;
    /**
     * Optional list of output modes supported by this skill, overriding agent defaults.
     * @default null
     */
    outputModes?: string[] | null;
}
/**
 * Represents the metadata card for an agent, describing its properties and capabilities.
 */
interface AgentCard {
    /**
     * The name of the agent.
     */
    name: string;
    /**
     * An optional description of the agent.
     * @default null
     */
    description?: string | null;
    /**
     * The base URL endpoint for interacting with the agent.
     */
    url: string;
    /**
     * Information about the provider of the agent.
     * @default null
     */
    provider?: AgentProvider | null;
    /**
     * The version identifier for the agent or its API.
     */
    version: string;
    /**
     * An optional URL pointing to the agent's documentation.
     * @default null
     */
    documentationUrl?: string | null;
    /**
     * The capabilities supported by the agent.
     */
    capabilities: AgentCapabilities;
    /**
     * Authentication details required to interact with the agent.
     * @default null
     */
    authentication?: AgentAuthentication | null;
    /**
     * Default input modes supported by the agent (e.g., 'text', 'file', 'json').
     * @default ["text"]
     */
    defaultInputModes?: string[];
    /**
     * Default output modes supported by the agent (e.g., 'text', 'file', 'json').
     * @default ["text"]
     */
    defaultOutputModes?: string[];
    /**
     * List of specific skills offered by the agent.
     */
    skills: AgentSkill[];
}
interface FileContentBase {
    /**
     * Optional name of the file.
     * @default null
     */
    name?: string | null;
    /**
     * Optional MIME type of the file content.
     * @default null
     */
    mimeType?: string | null;
    /**
     * File content encoded as a Base64 string. Use this OR `uri`.
     */
    bytes?: string | null;
    /**
     * URI pointing to the file content. Use this OR `bytes`.
     */
    uri?: string | null;
}
type FileContentBytes = FileContentBase & {
    bytes: string;
    uri?: never;
};
type FileContentUri = FileContentBase & {
    /** URI pointing to the file content. */
    uri: string;
    bytes?: never;
};
/**
 * Represents the content of a file, either as base64 encoded bytes or a URI.
 * @description Ensures that either 'bytes' or 'uri' is provided, but not both. (Note: This constraint is informational in TypeScript types).
 */
type FileContent = FileContentBytes | FileContentUri;
/**
 * Represents a part of a message containing text content.
 */
interface TextPart {
    type: 'text';
    /**
     * The text content.
     */
    text: string;
    /**
     * Optional metadata associated with this text part.
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Represents a part of a message containing file content.
 */
interface FilePart {
    /**
     * Type identifier for this part.
     */
    type: 'file';
    /**
     * The file content, provided either inline or via URI.
     */
    file: FileContent;
    /**
     * Optional metadata associated with this file part.
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Represents a part of a message containing structured data (JSON).
 */
interface DataPart {
    /**
     * Type identifier for this part.
     */
    type: 'data';
    /**
     * The structured data content as a JSON object.
     */
    data: Record<string, unknown>;
    /**
     * Optional metadata associated with this data part.
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Represents a single part of a multi-part message. Can be text, file, or data.
 */
type Part = TextPart | FilePart | DataPart;
/**
 * Represents an artifact generated or used by a task, potentially composed of multiple parts.
 */
interface Artifact {
    /**
     * Optional name for the artifact.
     * @default null
     */
    name?: string | null;
    /**
     * Optional description of the artifact.
     * @default null
     */
    description?: string | null;
    /**
     * The constituent parts of the artifact.
     */
    parts: Part[];
    /**
     * Optional index for ordering artifacts, especially relevant in streaming or updates.
     * @default 0
     */
    index?: number;
    /**
     * Optional flag indicating if this artifact content should append to previous content (for streaming).
     * @default null
     */
    append?: boolean | null;
    /**
     * Optional metadata associated with the artifact.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
    /**
     * Optional flag indicating if this is the last chunk of data for this artifact (for streaming).
     * @default null
     */
    lastChunk?: boolean | null;
}
/**
 * Represents a message exchanged between a user and an agent.
 */
interface Message {
    /**
     * The role of the sender (user or agent).
     */
    role: 'user' | 'agent';
    /**
     * The content of the message, composed of one or more parts.
     */
    parts: Part[];
    /**
     * Optional metadata associated with the message.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Represents the status of a task at a specific point in time.
 */
interface TaskStatus {
    /**
     * The current state of the task.
     */
    state: TaskState;
    /**
     * An optional message associated with the current status (e.g., progress update, final response).
     * @default null
     */
    message?: Message | null;
    /**
     * The timestamp when this status was recorded (ISO 8601 format).
     * @format date-time
     */
    timestamp?: string;
}
/**
 * Represents a task being processed by an agent.
 */
interface Task {
    /**
     * Unique identifier for the task.
     */
    id: string;
    /**
     * Optional identifier for the session this task belongs to.
     * @default null
     */
    sessionId?: string | null;
    /**
     * The current status of the task.
     */
    status: TaskStatus;
    /**
     * Optional list of artifacts associated with the task (e.g., outputs, intermediate files).
     * @default null
     */
    artifacts?: Artifact[] | null;
    /**
     * Optional metadata associated with the task.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Represents the history of messages exchanged within a task's session.
 */
interface TaskHistory {
    /**
     * List of messages in chronological order.
     * @default []
     */
    messageHistory?: Message[];
}
/**
 * Represents a status update event for a task, typically used in streaming scenarios.
 */
interface TaskStatusUpdateEvent {
    /**
     * The ID of the task being updated.
     */
    id: string;
    /**
     * The new status of the task.
     */
    status: TaskStatus;
    /**
     * Flag indicating if this is the final update for the task.
     * @default false
     */
    final?: boolean;
    /**
     * Optional metadata associated with this update event.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Represents an artifact update event for a task, typically used in streaming scenarios.
 */
interface TaskArtifactUpdateEvent {
    /**
     * The ID of the task being updated.
     */
    id: string;
    /**
     * The new or updated artifact for the task.
     */
    artifact: Artifact;
    /**
     * Flag indicating if this is the final update for the task.
     * @default false
     */
    final?: boolean;
    /**
     * Optional metadata associated with this update event.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
}
type TaskUpdateEvent = TaskStatusUpdateEvent;
/** Error code for JSON Parse Error (-32700). Invalid JSON was received by the server. */
declare const ErrorCodeParseError = -32700;
type ErrorCodeParseError = typeof ErrorCodeParseError;
/** Error code for Invalid Request (-32600). The JSON sent is not a valid Request object. */
declare const ErrorCodeInvalidRequest = -32600;
type ErrorCodeInvalidRequest = typeof ErrorCodeInvalidRequest;
/** Error code for Method Not Found (-32601). The method does not exist / is not available. */
declare const ErrorCodeMethodNotFound = -32601;
type ErrorCodeMethodNotFound = typeof ErrorCodeMethodNotFound;
/** Error code for Invalid Params (-32602). Invalid method parameter(s). */
declare const ErrorCodeInvalidParams = -32602;
type ErrorCodeInvalidParams = typeof ErrorCodeInvalidParams;
/** Error code for Internal Error (-32603). Internal JSON-RPC error. */
declare const ErrorCodeInternalError = -32603;
type ErrorCodeInternalError = typeof ErrorCodeInternalError;
/** Error code for Task Not Found (-32001). The specified task was not found. */
declare const ErrorCodeTaskNotFound = -32001;
type ErrorCodeTaskNotFound = typeof ErrorCodeTaskNotFound;
/** Error code for Task Not Cancelable (-32002). The specified task cannot be canceled. */
declare const ErrorCodeTaskNotCancelable = -32002;
type ErrorCodeTaskNotCancelable = typeof ErrorCodeTaskNotCancelable;
/** Error code for Push Notification Not Supported (-32003). Push Notifications are not supported for this operation or agent. */
declare const ErrorCodePushNotificationNotSupported = -32003;
type ErrorCodePushNotificationNotSupported = typeof ErrorCodePushNotificationNotSupported;
/** Error code for Unsupported Operation (-32004). The requested operation is not supported by the agent. */
declare const ErrorCodeUnsupportedOperation = -32004;
type ErrorCodeUnsupportedOperation = typeof ErrorCodeUnsupportedOperation;
/**
 * Union of all well-known A2A and standard JSON-RPC error codes defined in this schema.
 * Use this type for checking against specific error codes. A server might theoretically
 * use other codes within the valid JSON-RPC ranges.
 */
type KnownErrorCode = typeof ErrorCodeParseError | typeof ErrorCodeInvalidRequest | typeof ErrorCodeMethodNotFound | typeof ErrorCodeInvalidParams | typeof ErrorCodeInternalError | typeof ErrorCodeTaskNotFound | typeof ErrorCodeTaskNotCancelable | typeof ErrorCodePushNotificationNotSupported | typeof ErrorCodeUnsupportedOperation;
type A2AError$1 = JSONRPCError<unknown | null, KnownErrorCode | number>;
/**
 * Authentication information, potentially including additional properties beyond the standard ones.
 * (Note: Schema allows additional properties).
 */
interface AuthenticationInfo extends AgentAuthentication {
    /** Allow any other properties */
    [key: string]: any;
}
/**
 * Information required for setting up push notifications.
 */
interface PushNotificationConfig {
    /**
     * The URL endpoint where the agent should send notifications.
     */
    url: string;
    /**
     * A token to be included in push notification requests for verification/authentication.
     */
    token?: string;
    /**
     * Optional authentication details needed by the agent to call the notification URL.
     * @default null
     */
    authentication?: AuthenticationInfo | null;
}
/**
 * Represents the push notification information associated with a specific task ID.
 * Used as parameters for `tasks/pushNotification/set` and as a result type.
 */
interface TaskPushNotificationConfig {
    /**
     * The ID of the task the notification config is associated with.
     */
    id: string;
    /**
     * The push notification configuration details.
     */
    pushNotificationConfig: PushNotificationConfig;
}
/**
 * Parameters for the `tasks/send` method.
 */
interface TaskSendParams {
    /**
     * Unique identifier for the task being initiated or continued.
     */
    id: string;
    /**
     * Optional identifier for the session this task belongs to. If not provided, a new session might be implicitly created depending on the agent.
     */
    sessionId?: string;
    /**
     * The message content to send to the agent for processing.
     */
    message: Message;
    /**
     * Optional pushNotification information for receiving notifications about this task. Requires agent capability.
     * @default null
     */
    pushNotification?: PushNotificationConfig | null;
    /**
     * Optional parameter to specify how much message history to include in the response.
     * @default null
     */
    historyLength?: number | null;
    /**
     * Optional metadata associated with sending this message.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Basic parameters used for task ID operations.
 * Used by: `tasks/cancel`, `tasks/pushNotification/get`.
 */
interface TaskIdParams {
    /**
     * The unique identifier of the task.
     */
    id: string;
    /**
     * Optional metadata to include with the operation.
     * @default null
     */
    metadata?: Record<string, unknown> | null;
}
/**
 * Parameters used for querying task-related information by ID.
 * Used by: `tasks/get`, `tasks/getHistory`, `tasks/subscribe`, `tasks/resubscribe`.
 */
interface TaskQueryParams extends TaskIdParams {
    /**
     * Optional history length to retrieve for the task.
     * @default null
     */
    historyLength?: number | null;
}
/**
 * Request to send a message/initiate a task.
 */
interface SendTaskRequest extends JSONRPCRequest {
    /**
     * Method name for sending a task message.
     */
    method: 'tasks/send';
    /**
     * Parameters for the send task method.
     */
    params: TaskSendParams;
}
/**
 * Request to retrieve the current state of a task.
 */
interface GetTaskRequest extends JSONRPCRequest {
    /**
     * Method name for getting task status.
     */
    method: 'tasks/get';
    /**
     * Parameters for the get task method.
     */
    params: TaskQueryParams;
}
/**
 * Request to cancel a currently running task.
 */
interface CancelTaskRequest extends JSONRPCRequest {
    /**
     * Method name for canceling a task.
     */
    method: 'tasks/cancel';
    /**
     * Parameters for the cancel task method.
     */
    params: TaskIdParams;
}
/**
 * Request to set or update the push notification config for a task.
 */
interface SetTaskPushNotificationRequest extends JSONRPCRequest {
    /**
     * Method name for setting a task notifications.
     */
    method: 'tasks/pushNotification/set';
    /**
     * Parameters for the set task push notification method.
     */
    params: TaskPushNotificationConfig;
}
/**
 * Request to retrieve the currently configured push notification configuration for a task.
 */
interface GetTaskPushNotificationRequest extends JSONRPCRequest {
    /**
     * Method name for getting task notification configuration.
     */
    method: 'tasks/pushNotification/get';
    /**
     * Parameters for the get task push notification config method.
     */
    params: TaskIdParams;
}
/**
 * Request to resubscribe to updates for a task after a connection interruption.
 */
interface TaskResubscriptionRequest extends JSONRPCRequest {
    /**
     * Method name for resubscribing to task updates.
     */
    method: 'tasks/resubscribe';
    /**
     * Parameters for the task resubscription method.
     */
    params: TaskQueryParams;
}
/**
 * Request to send a message/initiate a task and subscribe to streaming updates.
 */
interface SendTaskStreamingRequest extends JSONRPCRequest {
    /**
     * Method name for sending a task message and subscribing to updates.
     */
    method: 'tasks/sendSubscribe';
    /**
     * Parameters for the streaming task send method.
     */
    params: TaskSendParams;
}
/**
 * Response to a `tasks/send` request.
 * Contains the Task object or an error.
 */
type SendTaskResponse = JSONRPCResponse<Task | null, A2AError$1>;
/**
 * Response to a streaming task operation, either through `tasks/sendSubscribe` or a subscription.
 * Contains a TaskStatusUpdateEvent, TaskArtifactUpdateEvent, or an error.
 */
type SendTaskStreamingResponse = JSONRPCResponse<TaskStatusUpdateEvent | TaskArtifactUpdateEvent | null, A2AError$1>;
/**
 * Response to a `tasks/get` request. Contains the Task object or an error.
 */
type GetTaskResponse = JSONRPCResponse<Task | null, A2AError$1>;
/**
 * Response to a `tasks/cancel` request. Contains the updated Task object (usually with 'canceled' state) or an error.
 */
type CancelTaskResponse = JSONRPCResponse<Task | null, A2AError$1>;
/**
 * Response to a `tasks/getHistory` request. Contains the TaskHistory object or an error.
 */
type GetTaskHistoryResponse = JSONRPCResponse<TaskHistory | null, A2AError$1>;
/**
 * Response to a `tasks/pushNotification/set` request. Contains the confirmed TaskPushNotificationConfig or an error.
 */
type SetTaskPushNotificationResponse = JSONRPCResponse<TaskPushNotificationConfig | null, A2AError$1>;
/**
 * Response to a `tasks/pushNotification/get` request. Contains the TaskPushNotificationConfig or an error.
 */
type GetTaskPushNotificationResponse = JSONRPCResponse<TaskPushNotificationConfig | null, A2AError$1>;
/**
 * Represents any valid request defined in the A2A protocol.
 */
type A2ARequest = SendTaskRequest | GetTaskRequest | CancelTaskRequest | SetTaskPushNotificationRequest | GetTaskPushNotificationRequest | TaskResubscriptionRequest | SendTaskStreamingRequest;
/**
 * Represents any valid JSON-RPC response defined in the A2A protocol.
 * (This is a helper type, not explicitly defined with `oneOf` in the schema like A2ARequest, but useful).
 */
type A2AResponse = SendTaskResponse | GetTaskResponse | CancelTaskResponse | GetTaskHistoryResponse | SetTaskPushNotificationResponse | GetTaskPushNotificationResponse;
interface TaskAndHistory {
    task: Task;
    history: Message[];
}
interface TaskContext {
    /**
     * The current state of the task when the handler is invoked or resumed.
     * Note: This is a snapshot. For the absolute latest state during async operations,
     * the handler might need to reload the task via the store.
     */
    task: Task;
    /**
     * The specific user message that triggered this handler invocation or resumption.
     */
    userMessage: Message;
    /**
     * Function to check if cancellation has been requested for this task.
     * Handlers should ideally check this periodically during long-running operations.
     * @returns {boolean} True if cancellation has been requested, false otherwise.
     */
    isCancelled(): boolean;
    /**
     * The message history associated with the task up to the point the handler is invoked.
     * Optional, as history might not always be available or relevant.
     */
    history?: Message[];
}

/**
 * Custom error class for A2A server operations, incorporating JSON-RPC error codes.
 */
declare class A2AError extends Error {
    code: KnownErrorCode | number;
    data?: unknown;
    taskId?: string;
    constructor(code: KnownErrorCode | number, message: string, data?: unknown, taskId?: string);
    /**
     * Formats the error into a standard JSON-RPC error object structure.
     */
    toJSONRPCError(): JSONRPCError<unknown>;
    static parseError(message: string, data?: unknown): A2AError;
    static invalidRequest(message: string, data?: unknown): A2AError;
    static methodNotFound(method: string): A2AError;
    static invalidParams(message: string, data?: unknown): A2AError;
    static internalError(message: string, data?: unknown): A2AError;
    static taskNotFound(taskId: string): A2AError;
    static taskNotCancelable(taskId: string): A2AError;
    static pushNotificationNotSupported(): A2AError;
    static unsupportedOperation(operation: string): A2AError;
}

export { A2AError, type A2ARequest, type A2AResponse, type AgentAuthentication, type AgentCapabilities, type AgentCard, type AgentProvider, type AgentSkill, type Artifact, type AuthenticationInfo, type CancelTaskRequest, type CancelTaskResponse, type DataPart, ErrorCodeInternalError, ErrorCodeInvalidParams, ErrorCodeInvalidRequest, ErrorCodeMethodNotFound, ErrorCodeParseError, ErrorCodePushNotificationNotSupported, ErrorCodeTaskNotCancelable, ErrorCodeTaskNotFound, ErrorCodeUnsupportedOperation, type FileContent, type FileContentBase, type FileContentBytes, type FileContentUri, type FilePart, type GetTaskHistoryResponse, type GetTaskPushNotificationRequest, type GetTaskPushNotificationResponse, type GetTaskRequest, type GetTaskResponse, type JSONRPCError, type JSONRPCMessage, type JSONRPCMessageIdentifier, type JSONRPCRequest, type JSONRPCResponse, type KnownErrorCode, type Message, type Part, type PushNotificationConfig, type SendTaskRequest, type SendTaskResponse, type SendTaskStreamingRequest, type SendTaskStreamingResponse, type SetTaskPushNotificationRequest, type SetTaskPushNotificationResponse, type Task, type TaskAndHistory, type TaskArtifactUpdateEvent, type TaskContext, type TaskHistory, type TaskIdParams, type TaskPushNotificationConfig, type TaskQueryParams, type TaskResubscriptionRequest, type TaskSendParams, type TaskState, type TaskStatus, type TaskStatusUpdateEvent, type TaskUpdateEvent, type TextPart };
