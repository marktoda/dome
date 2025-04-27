/**
 * Chat Orchestrator WebSocket Client
 *
 * This file exports a type-safe WebSocket client for interacting with the Chat Orchestrator service.
 * It provides methods for WebSocket connection, handling messages and reconnection logic.
 */

import { getLogger, logError, metrics } from '@dome/logging';
import { ChatRequest, chatRequestSchema, ResumeChatRequest } from '../types';
import { MessageType, WebSocketMessage } from '../utils/wsTransformer';

/**
 * Event callbacks for WebSocket chat session
 */
export interface WebSocketCallbacks {
  onText?: (text: string) => void;
  onSources?: (sources: any[]) => void;
  onWorkflowStep?: (step: string) => void;
  onFinal?: (metadata: { executionTimeMs: number }) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
}

/**
 * Options for WebSocket connections
 */
export interface WebSocketOptions {
  /** Auto reconnect on connection loss */
  autoReconnect?: boolean;
  /** Max reconnection attempts */
  maxReconnectAttempts?: number;
  /** Base reconnection delay in ms (increases with backoff) */
  reconnectDelayMs?: number;
  /** Maximum backoff for reconnection delay */
  maxReconnectDelayMs?: number;
}

/**
 * Chat orchestrator WebSocket client
 */
export class WebSocketClient {
  private webSocket: WebSocket | null = null;
  private logger = getLogger().child({ component: 'WebSocketClient' });
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private options: Required<WebSocketOptions>;
  private callbackHandlers: WebSocketCallbacks = {};
  private isClosingIntentionally = false;

  /**
   * Create a new chat orchestrator WebSocket client
   * @param url Base URL of the Chat Orchestrator service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'chat_orchestrator.ws_client')
   * @param options WebSocket connection options
   */
  constructor(
    private readonly url: string,
    private readonly metricsPrefix: string = 'chat_orchestrator.ws_client',
    options: WebSocketOptions = {}
  ) {
    // Set default options
    this.options = {
      autoReconnect: options.autoReconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      reconnectDelayMs: options.reconnectDelayMs ?? 1000,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 30000
    };
  }

  /**
   * Generate a chat response via WebSocket
   * @param request Chat request
   * @param callbacks Callback handlers for WebSocket events
   * @returns Promise that resolves when the connection is established
   */
  async generateChatResponse(
    request: ChatRequest,
    callbacks: WebSocketCallbacks
  ): Promise<void> {
    const startTime = performance.now();

    try {
      // Validate request
      const validatedRequest = chatRequestSchema.parse(request);

      // Store the callbacks
      this.callbackHandlers = callbacks;

      // Prepare the WebSocket URL
      const wsUrl = this.getWebSocketUrl('new_chat');

      // Connect to the WebSocket
      this.reconnectAttempts = 0;
      await this.connect(wsUrl);

      // Send the initial message
      this.sendMessage({
        type: 'new_chat',
        ...validatedRequest
      });

      // Track metrics
      metrics.increment(`${this.metricsPrefix}.connect.success`, 1);
      metrics.timing(
        `${this.metricsPrefix}.connect.latency_ms`,
        performance.now() - startTime
      );
    } catch (error) {
      logError(error, 'Error establishing WebSocket chat connection', {
        userId: request.userId,
      });

      // Track error metrics
      metrics.increment(`${this.metricsPrefix}.connect.errors`, 1, {
        errorType: error instanceof Error ? error.constructor.name : 'unknown',
      });

      // Invoke error callback if provided
      if (this.callbackHandlers.onError) {
        this.callbackHandlers.onError(error instanceof Error ? error.message : String(error));
      }

      throw error;
    }
  }

  /**
   * Resume a chat session via WebSocket
   * @param request Resume chat request
   * @param callbacks Callback handlers for WebSocket events
   * @returns Promise that resolves when the connection is established
   */
  async resumeChatSession(
    request: ResumeChatRequest,
    callbacks: WebSocketCallbacks
  ): Promise<void> {
    const startTime = performance.now();

    try {
      // Store the callbacks
      this.callbackHandlers = callbacks;

      // Prepare the WebSocket URL
      const wsUrl = this.getWebSocketUrl('resume_chat');

      // Connect to the WebSocket
      this.reconnectAttempts = 0;
      await this.connect(wsUrl);

      // Send the initial message
      this.sendMessage({
        type: 'resume_chat',
        ...request
      });

      // Track metrics
      metrics.increment(`${this.metricsPrefix}.resume.success`, 1);
      metrics.timing(
        `${this.metricsPrefix}.resume.latency_ms`,
        performance.now() - startTime
      );
    } catch (error) {
      logError(error, 'Error resuming WebSocket chat session', {
        runId: request.runId,
      });

      // Track error metrics
      metrics.increment(`${this.metricsPrefix}.resume.errors`, 1, {
        errorType: error instanceof Error ? error.constructor.name : 'unknown',
      });

      // Invoke error callback if provided
      if (this.callbackHandlers.onError) {
        this.callbackHandlers.onError(error instanceof Error ? error.message : String(error));
      }

      throw error;
    }
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    if (this.webSocket) {
      this.isClosingIntentionally = true;
      this.webSocket.close();
      this.webSocket = null;
      this.logger.info('WebSocket connection closed intentionally');
    }

    // Clear any reconnection timeout
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /**
   * Connect to a WebSocket URL
   * @param wsUrl WebSocket URL
   * @returns Promise that resolves when connected
   */
  private connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.logger.info({ url: wsUrl }, 'Connecting to WebSocket');

        // Create a new WebSocket
        this.webSocket = new WebSocket(wsUrl);

        // Set up event handlers using addEventListener (Cloudflare Workers compatible approach)
        this.webSocket.addEventListener('open', () => {
          this.logger.info('WebSocket connected successfully');
          this.reconnectAttempts = 0;
          resolve();
        });

        this.webSocket.addEventListener('message', (event: WebSocketEventMap['message']) => {
          this.handleMessage(event);
        });

        this.webSocket.addEventListener('error', (event: WebSocketEventMap['error']) => {
          this.logger.error('WebSocket error occurred');
          
          // Only reject the promise if we haven't connected yet
          if (this.webSocket?.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket connection error'));
          }
          
          // Invoke error callback if provided
          if (this.callbackHandlers.onError) {
            this.callbackHandlers.onError('WebSocket connection error');
          }
        });

        this.webSocket.addEventListener('close', (event: WebSocketEventMap['close']) => {
          this.logger.info({
            code: event.code,
            reason: event.reason
          }, 'WebSocket closed');
          
          this.webSocket = null;

          // Don't attempt to reconnect if this was an intentional close
          if (!this.isClosingIntentionally && this.options.autoReconnect) {
            this.attemptReconnect(wsUrl);
          } else {
            // If this was intended, reset the flag
            this.isClosingIntentionally = false;
            
            // Call the end callback if provided
            if (this.callbackHandlers.onEnd) {
              this.callbackHandlers.onEnd();
            }
          }
        });
      } catch (error) {
        this.logger.error({ error }, 'Error creating WebSocket');
        reject(error);
      }
    });
  }

  /**
   * Send a message through the WebSocket
   * @param message Message to send
   */
  private sendMessage(message: any): void {
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      const jsonMessage = JSON.stringify(message);
      this.webSocket.send(jsonMessage);
      this.logger.debug({ messageType: message.type }, 'Sent WebSocket message');
    } else {
      this.logger.warn(
        { readyState: this.webSocket?.readyState }, 
        'Cannot send message, WebSocket not open'
      );
      
      if (this.callbackHandlers.onError) {
        this.callbackHandlers.onError('WebSocket not connected');
      }
    }
  }

  /**
   * Handle a message from the WebSocket
   * @param event Message event
   */
  private handleMessage(event: WebSocketEventMap['message']): void {
    try {
      // Cloudflare WebSocket's data property can be string or ArrayBuffer
      const data = typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      
      const message = JSON.parse(data) as WebSocketMessage;
      
      this.logger.debug({
        messageType: message.type,
        dataKeys: Object.keys(message.data)
      }, 'Received WebSocket message');

      // Dispatch to the appropriate handler
      switch (message.type) {
        case MessageType.TEXT:
          if (this.callbackHandlers.onText && message.data.text) {
            this.callbackHandlers.onText(message.data.text);
          }
          break;
          
        case MessageType.SOURCES:
          if (this.callbackHandlers.onSources && message.data.sources) {
            this.callbackHandlers.onSources(message.data.sources);
          }
          break;
          
        case MessageType.WORKFLOW_STEP:
          if (this.callbackHandlers.onWorkflowStep && message.data.step) {
            this.callbackHandlers.onWorkflowStep(message.data.step);
          }
          break;
          
        case MessageType.FINAL:
          if (this.callbackHandlers.onFinal && message.data.executionTimeMs) {
            this.callbackHandlers.onFinal({ 
              executionTimeMs: message.data.executionTimeMs 
            });
          }
          break;
          
        case MessageType.ERROR:
          if (this.callbackHandlers.onError && message.data.message) {
            this.callbackHandlers.onError(message.data.message);
          }
          break;
          
        case MessageType.END:
          if (this.callbackHandlers.onEnd) {
            this.callbackHandlers.onEnd();
          }
          break;
          
        default:
          this.logger.warn({ type: message.type }, 'Unknown message type received');
      }
    } catch (error) {
      this.logger.error({ error, data: event.data }, 'Error parsing WebSocket message');
      
      if (this.callbackHandlers.onError) {
        this.callbackHandlers.onError('Error parsing message from server');
      }
    }
  }

  /**
   * Attempt to reconnect to the WebSocket
   * @param wsUrl WebSocket URL
   */
  private attemptReconnect(wsUrl: string): void {
    // Clear any existing timeout
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
    }

    // Check if we've exceeded the max reconnect attempts
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.logger.warn(
        { attempts: this.reconnectAttempts }, 
        'Max reconnect attempts reached, giving up'
      );
      
      if (this.callbackHandlers.onError) {
        this.callbackHandlers.onError('Connection lost. Max reconnection attempts reached.');
      }
      
      return;
    }

    // Increment reconnect attempts
    this.reconnectAttempts++;

    // Calculate backoff delay (exponential backoff with jitter)
    const baseDelay = Math.min(
      this.options.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1),
      this.options.maxReconnectDelayMs
    );
    
    // Add jitter (±15%)
    const jitter = baseDelay * 0.3 * (Math.random() - 0.5);
    const delay = Math.floor(baseDelay + jitter);

    this.logger.info(
      { 
        attempt: this.reconnectAttempts, 
        maxAttempts: this.options.maxReconnectAttempts,
        delayMs: delay 
      },
      'Scheduling WebSocket reconnection attempt'
    );

    // Schedule reconnection
    this.reconnectTimeout = setTimeout(() => {
      this.logger.info({ attempt: this.reconnectAttempts }, 'Attempting to reconnect WebSocket');
      
      this.connect(wsUrl).catch(error => {
        this.logger.error({ error, attempt: this.reconnectAttempts }, 'Reconnection failed');
      });
    }, delay);
  }

  /**
   * Get a WebSocket URL for the chat service
   * @param type Connection type ('new_chat' or 'resume_chat')
   * @returns WebSocket URL
   */
  private getWebSocketUrl(type: 'new_chat' | 'resume_chat'): string {
    // Convert http(s) to ws(s)
    const wsBase = this.url.replace(/^http/, 'ws');
    return `${wsBase}/chat/ws?type=${type}`;
  }
}

/**
 * Create a new WebSocketClient
 * @param url Base URL of the Chat Orchestrator service
 * @param metricsPrefix Optional prefix for metrics
 * @param options WebSocket connection options
 * @returns WebSocketClient instance
 */
export function createWebSocketClient(
  url: string,
  metricsPrefix?: string,
  options?: WebSocketOptions
): WebSocketClient {
  return new WebSocketClient(url, metricsPrefix, options);
}