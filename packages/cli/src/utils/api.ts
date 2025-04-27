import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { loadConfig, isAuthenticated } from './config';
import WebSocket from 'ws';

/**
 * API client for the dome API
 */
export class ApiClient {
  private client: AxiosInstance;
  private config: ReturnType<typeof loadConfig>;

  /**
   * Create a new API client
   * @param configOverride Optional config override for testing
   */
  constructor(configOverride?: ReturnType<typeof loadConfig>) {
    this.config = configOverride || loadConfig();

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor to add the API key to all requests
    this.client.interceptors.request.use(config => {
      if (isAuthenticated()) {
        config.headers['x-api-key'] = this.config.apiKey;
        // Add user ID header for controller-level authentication
        config.headers['x-user-id'] = 'test-user-id';
      }
      return config;
    });
  }

  /**
   * Make a GET request to the API
   * @param url The URL to request
   * @param config The request configuration
   * @returns The response data
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.get(url, config);
    return response.data;
  }

  /**
   * Make a POST request to the API
   * @param url The URL to request
   * @param data The data to send
   * @param config The request configuration
   * @returns The response data
   */
  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.post(url, data, config);
    return response.data;
  }

  /**
   * Make a PUT request to the API
   * @param url The URL to request
   * @param data The data to send
   * @param config The request configuration
   * @returns The response data
   */
  async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.put(url, data, config);
    return response.data;
  }

  /**
   * Make a DELETE request to the API
   * @param url The URL to request
   * @param config The request configuration
   * @returns The response data
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.delete(url, config);
    return response.data;
  }
}

// Create a lazy-loaded singleton instance of the API client
let apiInstance: ApiClient | null = null;

export function getApiInstance(): ApiClient {
  if (!apiInstance) {
    apiInstance = new ApiClient();
  }
  return apiInstance;
}

// For testing purposes
export function resetApiInstance(): void {
  apiInstance = null;
}

// Backward compatibility
export const api = {
  get: (url: string, config?: AxiosRequestConfig) => getApiInstance().get(url, config),
  post: (url: string, data?: any, config?: AxiosRequestConfig) =>
    getApiInstance().post(url, data, config),
  put: (url: string, data?: any, config?: AxiosRequestConfig) =>
    getApiInstance().put(url, data, config),
  delete: (url: string, config?: AxiosRequestConfig) => getApiInstance().delete(url, config),
};

/**
 * Add content to the dome API
 * @param content The content to add
 * @returns The response data
 */
export async function addContent(content: string, title?: string, tags?: string[]): Promise<any> {
  const payload = {
    content,
    contentType: 'text/plain',
    title: title || undefined,
    tags: tags || undefined,
  };

  const response = await api.post('/notes', payload);
  return response.note || response;
}

/**
 * Start or append to a note session
 * @param context The context for the note
 * @param content The content to add
 * @returns The response data
 */
export async function addNote(context: string, content: string): Promise<any> {
  return api.post('/notes', {
    content,
    contentType: 'text/plain',
    metadata: { context },
  });
}

/**
 * List notes or tasks
 * @param type The type of items to list ('notes' or 'tasks')
 * @param filter Optional filter criteria
 * @returns The response data
 */
export async function listItems(type: 'notes' | 'tasks', filter?: string): Promise<any> {
  const params: Record<string, any> = {
    fields: 'title,summary,body,tags,contentType,createdAt',
  };

  if (filter) {
    // The new API uses different filtering parameters
    if (type === 'notes') {
      // For notes, we might filter by contentType
      params.contentType = filter;
    } else {
      // For tasks, we might filter by status or priority
      params.status = filter;
    }
  }

  // Use the correct endpoint based on type
  const endpoint = type === 'notes' ? '/notes' : '/tasks';
  const response = await api.get(endpoint, { params });
  // Extract the items array from the response
  // The API might return items in different properties based on the type
  let items = [];

  if (type === 'notes') {
    items = Array.isArray(response.notes)
      ? response.notes
      : Array.isArray(response.items)
        ? response.items
        : Array.isArray(response)
          ? response
          : [];
  } else {
    items = Array.isArray(response.tasks)
      ? response.tasks
      : Array.isArray(response.items)
        ? response.items
        : Array.isArray(response)
          ? response
          : [];
  }

  // Return an object with the appropriate property containing the items array
  return {
    [type]: items,
    items: items,
    total: response.total || items.length,
  };
}

/**
 * List notes
 * @param filter Optional filter criteria
 * @returns The response data with notes
 */
export async function listNotes(filter?: string): Promise<any> {
  return listItems('notes', filter);
}

/**
 * List tasks
 * @param filter Optional filter criteria
 * @returns The response data with tasks
 */
export async function listTasks(filter?: string): Promise<any> {
  return listItems('tasks', filter);
}

/**
 * Show a specific note or task
 * @param id The ID of the item to show
 * @returns The response data
 */
export async function showItem(id: string): Promise<any> {
  const response = await api.get(`/notes/${id}`);
  return response.note || response;
}

/**
 * Search across all stored content types
 * @param query The search query
 * @param limit Maximum number of results to return
 * @returns The response data with results from all content types
 */
export async function search(query: string, limit: number = 10): Promise<any> {
  const params = {
    q: query,
    limit,
    fields: 'title,summary,body,tags,contentType,createdAt',
  };

  // Use the dedicated search endpoint
  const response = await api.get('/search', { params });

  // Ensure scores are properly mapped from the response
  const results = (response.results || []).map((result: any) => {
    // Make sure score is a number (not a string) and has a valid value
    if (result.score === undefined || result.score === null) {
      result.score = 0;
    } else if (typeof result.score === 'string') {
      result.score = parseFloat(result.score);
    }
    return result;
  });

  return {
    results: results,
    pagination: response.pagination || { total: 0, limit, offset: 0, hasMore: false },
    query,
  };
}

/**
 * Message chunk type for streaming responses
 */
export type ChatMessageChunk = {
  type: 'content' | 'thinking' | 'unknown';
  content: string;
};

/**
 * Connect to the WebSocket streaming chat interface
 * @param message The message to send
 * @param onChunk Callback function to handle streaming chunks
 * @returns A promise that resolves with any final metadata or rejects with an error
 */
export function connectWebSocketChat(
  message: string,
  onChunk: (chunk: ChatMessageChunk) => void,
  options: { debug?: boolean } = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const config = loadConfig();
      
      // The dome-api endpoint is /chat
      let wsUrl = config.baseUrl.replace(/^http/, 'ws');
      wsUrl = `${wsUrl}/chat`;

      if (options.debug) {
        console.log(`[DEBUG] Connecting to WebSocket: ${wsUrl}`);
      }
      
      // Create WebSocket connection with headers in the connection string
      // Some WebSocket implementations don't support headers in the options
      const apiKey = config.apiKey || '';
      const authParams = `?apiKey=${encodeURIComponent(apiKey)}&userId=test-user-id`;
      const wsUrlWithAuth = `${wsUrl}${authParams}`;
      
      const ws = new WebSocket(wsUrlWithAuth);
      
      // Track the complete response
      let fullResponse = '';
      
      // Set up event handlers
      ws.on('open', () => {
        if (options.debug) {
          console.log('[DEBUG] WebSocket connection established');
        }
        
        // Create the exact message format expected by the chat service
        // Important: Looking at the server logs, we need to make sure the
        // JSON string is exactly what the server expects
        const chatMessage = {
          userId: 'test-user-id',
          messages: [
            {
              role: 'user',
              content: message,
              timestamp: Date.now(),
            },
          ],
          options: {
            enhanceWithContext: true,
            maxContextItems: 5,
            includeSourceInfo: true,
            maxTokens: 1000,
            temperature: 0.7,
          },
          stream: true
        };
        
        // Send the JSON string directly
        ws.send(JSON.stringify(chatMessage));
      });
      
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const chunk = data.toString();
          if (options.debug) {
            console.log(`[DEBUG] Received chunk: ${chunk.substring(0, 80)}${chunk.length > 80 ? '...' : ''}`);
          }
          
          try {
            // Parse the JSON response from LangChain
            const parsed = JSON.parse(chunk);
            
            // Extract just the content from the LangChain message chunk
            if (Array.isArray(parsed) && parsed.length > 0 &&
                parsed[0].type === 'constructor' &&
                parsed[0].id &&
                parsed[0].id[2] === 'AIMessageChunk' &&
                parsed[0].kwargs &&
                parsed[0].kwargs.content !== undefined) {
              
              const content = parsed[0].kwargs.content;
              
              // Check if this is a thinking/analysis JSON object
              try {
                const contentObj = JSON.parse(content);
                if (contentObj &&
                    typeof contentObj === 'object' &&
                    'isComplex' in contentObj &&
                    'shouldSplit' in contentObj &&
                    'reason' in contentObj) {
                  // This is a thinking step - don't add to full response
                  // Send a special formatted chunk for thinking steps
                  onChunk({
                    type: 'thinking',
                    content: JSON.stringify(contentObj, null, 2)
                  });
                  return;
                }
              } catch (jsonError) {
                // Not a JSON object, treat as normal content
              }
              
              // Normal content
              fullResponse += content;
              onChunk({
                type: 'content',
                content
              });
            } else {
              // If we can't find the expected structure, just use the whole chunk
              fullResponse += chunk;
              onChunk({
                type: 'unknown',
                content: chunk
              });
            }
          } catch (e) {
            // If it's not valid JSON, use it directly
            fullResponse += chunk;
            onChunk({
              type: 'unknown',
              content: chunk
            });
          }
        } catch (err) {
          if (options.debug) {
            console.error('[DEBUG] Error processing WebSocket message:', err);
          }
        }
      });
      
      ws.on('close', () => {
        if (options.debug) {
          console.log('[DEBUG] WebSocket connection closed');
        }
        resolve({
          response: fullResponse,
          success: true
        });
      });
      
      ws.on('error', (error: Error) => {
        if (options.debug) {
          console.error('[DEBUG] WebSocket error:', error);
        }
        reject(error);
      });
      
      // Set a timeout in case the server doesn't close the connection
      const timeout = setTimeout(() => {
        if (options.debug) {
          console.log('[DEBUG] WebSocket timeout - closing connection');
        }
        ws.close();
        resolve({
          response: fullResponse,
          success: true,
          note: 'Connection timed out but partial response recovered'
        });
      }, 60000); // 60 second timeout
      
      // Clear timeout when connection closes
      ws.on('close', () => clearTimeout(timeout));
      
    } catch (error) {
      if (options.debug) {
        console.error('[DEBUG] Error setting up WebSocket:', error);
      }
      reject(error);
    }
  });
}

/**
 * Chat with the RAG-enhanced interface
 * @param message The message to send
 * @param onChunk Optional callback function to handle streaming chunks
 * @param streamingOptions Optional streaming configuration
 * @returns The response data (complete response when not streaming)
 */
export async function chat(
  message: string,
  onChunk?: (chunk: string | ChatMessageChunk) => void,
  streamingOptions?: { abortSignal?: AbortSignal; retryNonStreaming?: boolean; debug?: boolean },
): Promise<any> {
  // Default to retry with non-streaming if not specified
  const shouldRetryNonStreaming = streamingOptions?.retryNonStreaming !== false;

  // The chat API expects a unified structure
  const payload = {
    userId: 'test-user-id', // Default user ID for CLI
    messages: [
      {
        role: 'user',
        content: message,
        timestamp: Date.now(),
      },
    ],
    options: {
      enhanceWithContext: true, // Explicitly enable context enhancement
      maxContextItems: 5,
      includeSourceInfo: true,
      maxTokens: 1000,
      temperature: 0.7,
    },
    stream: !!onChunk, // Enable streaming if onChunk callback is provided
  };

  // If streaming is enabled, use WebSocket for streaming
  if (onChunk) {
    try {
      // Try WebSocket streaming first with an adapter for the chunk handler
      return await connectWebSocketChat(
        message,
        (chunkData: ChatMessageChunk) => {
          if (onChunk) {
            // Create appropriate adapter to handle structured chunks
            if (typeof chunkData === 'string') {
              // Handle legacy string chunks
              onChunk(chunkData);
            } else {
              // Handle new structured chunks
              onChunk(chunkData.content);
            }
          }
        },
        { debug: streamingOptions?.debug || false }
      );
    } catch (error) {
      console.log(
        '[DEBUG] WebSocket streaming failed:',
        error instanceof Error ? error.message : String(error)
      );
      
      // If we should retry with the old streaming method
      if (shouldRetryNonStreaming) {
        console.log('[DEBUG] Falling back to HTTP streaming');
        try {
          // Notify the user that we're falling back
          onChunk('\n[WebSocket streaming failed. Falling back to HTTP streaming...]\n');
          
          // Use the original HTTP streaming implementation
          return await httpStreamingChat(message, onChunk, streamingOptions);
        } catch (httpError) {
          console.log(
            '[DEBUG] HTTP streaming also failed:',
            httpError instanceof Error ? httpError.message : String(httpError)
          );
          
          // If both streaming methods fail, try non-streaming
          try {
            onChunk('\n[All streaming methods failed. Falling back to standard mode...]\n');
            
            // Create a non-streaming payload
            const nonStreamingPayload = {
              ...payload,
              stream: false,
            };
            
            // Make a non-streaming request
            const fallbackResponse = await api.post('/chat', nonStreamingPayload);
            
            // Extract the response text
            const responseText = getResponseText(fallbackResponse);
            
            // Send the complete response through the chunk handler
            onChunk(responseText);
            
            return {
              response: responseText,
              success: true,
              note: 'Fallback to non-streaming mode'
            };
          } catch (nonStreamingError) {
            console.log('[DEBUG] Non-streaming also failed:', nonStreamingError);
            return {
              success: false,
              error: { message: 'All communication methods failed.' },
              response: 'Failed to get a response from the server.'
            };
          }
        }
      }
      
      // If we shouldn't retry, just return the error
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Unknown',
          stack: error instanceof Error ? error.stack : undefined,
        },
        response: 'An error occurred during streaming. Please check the logs for more details.',
      };
    }
  } else {
    // Non-streaming path
    try {
      // Make sure stream is set to false for non-streaming requests
      const nonStreamingPayload = {
        ...payload,
        stream: false,
      };

      // Use the chat endpoint
      const response = await api.post('/chat', nonStreamingPayload);
      
      return getResponseText(response);
    } catch (error) {
      console.log(
        '[DEBUG] Error in non-streaming mode:',
        error instanceof Error ? error.message : String(error),
      );

      // Log more detailed error information
      if (error instanceof Error) {
        const errorObj = error as any;
        if (errorObj.response) {
          console.log('[DEBUG] Error response status:', errorObj.response.status);
          console.log('[DEBUG] Error response headers:', JSON.stringify(errorObj.response.headers));
          console.log('[DEBUG] Error response data:', JSON.stringify(errorObj.response.data));
        }
      }

      throw error;
    }
  }
}

/**
 * Original HTTP streaming implementation (used as a fallback)
 */
async function httpStreamingChat(
  message: string,
  onChunk: (chunk: string) => void,
  streamingOptions?: { abortSignal?: AbortSignal; retryNonStreaming?: boolean },
): Promise<any> {
  let fullResponse = '';
  // Define the type for sourceInfo
  let sourceInfo: Array<{ title?: string; snippet?: string }> | null = null;

  try {
    // Use axios directly with the base URL and headers from the config
    const config = loadConfig();

    const axiosInstance = axios.create({
      baseURL: config.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'x-user-id': 'test-user-id',
      },
    });

    // Create the payload
    const payload = {
      userId: 'test-user-id',
      messages: [
        {
          role: 'user',
          content: message,
          timestamp: Date.now(),
        },
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
        temperature: 0.7,
      },
      stream: true,
    };

    // Make the streaming request
    const response = await axiosInstance.post('/chat', payload, {
      responseType: 'stream',
      signal: streamingOptions?.abortSignal,
      timeout: 60000, // 60 second timeout
    });

    // Set up event handling for the stream
    const stream = response.data;

    // Create a promise that resolves when the stream ends
    return new Promise((resolve, reject) => {
      let buffer = '';
      let chunkCount = 0;
      let lastProcessedTime = Date.now();

      // Set up a watchdog timer to detect stalled streams
      const watchdogInterval = setInterval(() => {
        const now = Date.now();
        if (now - lastProcessedTime > 15000) {
          // 15 seconds without data
          clearInterval(watchdogInterval);

          // If we have some content, resolve with what we have
          if (fullResponse.length > 0) {
            resolve({
              response: fullResponse,
              sources: sourceInfo,
              success: true,
              note: 'Stream stalled but partial response recovered',
            });
          } else {
            reject(new Error('Stream stalled without producing content'));
          }
        }
      }, 5000);

      stream.on('data', (chunk: Buffer) => {
        lastProcessedTime = Date.now();
        chunkCount++;
        const chunkStr = chunk.toString();
        console.log(
          chunkStr.substring(0, 100) + (chunkStr.length > 100 ? '...' : ''),
        );
        buffer += chunkStr;

        // Process the buffer for complete SSE messages
        const lines = buffer.split('\n');
        buffer = ''; // Clear the buffer


        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();

          // Skip empty lines and "data: [DONE]" messages
          if (!line) {
            continue;
          }

          if (line === 'data: [DONE]') {
            continue;
          }

          // Handle plain text streaming (non-JSON format)
          if (!line.startsWith('data: ')) {
            fullResponse += line + '\n';
            onChunk(line + '\n');
            continue;
          }

          // Process data lines
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.substring(6); // Remove 'data: ' prefix

              // Handle non-JSON data format
              if (!jsonStr.trim().startsWith('{') && !jsonStr.trim().startsWith('[')) {
                fullResponse += jsonStr;
                onChunk(jsonStr);
                continue;
              }

              const data = JSON.parse(jsonStr);

              // Handle different response formats
              if (
                data.choices &&
                data.choices[0] &&
                data.choices[0].delta &&
                data.choices[0].delta.content
              ) {
                // OpenAI-style format
                const content = data.choices[0].delta.content;
                fullResponse += content;
                onChunk(content);
              } else if (data.response && typeof data.response === 'string') {
                // Direct response format
                fullResponse += data.response;
                onChunk(data.response);
              } else if (typeof data === 'string') {
                // Plain string format
                fullResponse += data;
                onChunk(data);
              } else {
                console.log(
                  JSON.stringify(data).substring(0, 100) +
                  (JSON.stringify(data).length > 100 ? '...' : ''),
                );

                // Try to extract any string content
                const extractedContent = JSON.stringify(data);
                if (extractedContent && extractedContent !== '{}' && extractedContent !== '[]') {
                  fullResponse += extractedContent;
                  onChunk(extractedContent);
                }
              }

              // Check for source information
              if (data.sources && Array.isArray(data.sources) && data.sources.length > 0) {
                sourceInfo = data.sources;
              }
            } catch (e) {

              // If it looks like plain text, just use it directly
              const content = line.substring(6); // Remove 'data: ' prefix
              if (content && content.trim()) {
                fullResponse += content;
                onChunk(content);
              } else {
                // If we can't parse this line, it might be incomplete
                // Add it back to the buffer for next time
                buffer += line + '\n';
              }
            }
          } else {
            // If it's not a data line but not empty, keep it for next processing
            buffer += line + '\n';
          }
        }
      });

      stream.on('end', () => {

        // Clear the watchdog timer
        clearInterval(watchdogInterval);

        // Resolve with the full response and any source information
        resolve({
          response: fullResponse,
          sources: sourceInfo,
          success: true,
        });
      });

      stream.on('error', (err: Error) => {

        // Clear the watchdog timer
        clearInterval(watchdogInterval);

        reject(err);
      });
    });
  } catch (error) {
    throw error;
  }
}

/**
 * Helper function to extract response text from various response formats
 */
function getResponseText(response: any): string {
  // Special case for the specific response structure we're seeing
  if (
    response &&
    response.success === true &&
    typeof response.response === 'object' &&
    response.response &&
    'response' in response.response &&
    response.response.response === ''
  ) {
    console.log('[DEBUG] Empty response string detected, returning fallback message');
    return "I'm sorry, but I couldn't generate a response at this time. The service may be experiencing issues.";
  }

  // Handle the response structure properly
  // Handle the new structure with data.response.response
  if (
    response &&
    response.success === true &&
    'data' in response &&
    response.data &&
    typeof response.data === 'object' &&
    'response' in response.data &&
    response.data.response &&
    typeof response.data.response === 'object' &&
    'response' in response.data.response &&
    typeof response.data.response.response === 'string'
  ) {
    return response.data.response.response;
  } else if (response && response.success === true && typeof response.response === 'string') {
    // Return just the response text if it's available
    return response.response;
  } else if (response && typeof response === 'string') {
    // If the response itself is a string, return it directly
    return response;
  } else if (response && typeof response === 'object' && 'response' in response) {
    // If response.response exists but isn't a string, convert it
    if (typeof response.response === 'object') {
      // Check if response.response has a 'response' property (nested response)
      if ('response' in response.response && typeof response.response.response === 'string') {
        return response.response.response;
      } else if ('response' in response.response) {
        // Handle case where response.response.response exists but isn't a string
        return String(
          response.response.response ||
          "I'm sorry, but I couldn't generate a response at this time.",
        );
      } else {
        // Try to extract any text from the object
        const responseText = JSON.stringify(response.response);
        if (responseText !== '{}' && responseText !== '[]') {
          return responseText;
        } else {
          // If the response is empty, provide a fallback message
          return "I'm sorry, but I couldn't generate a response at this time.";
        }
      }
    } else {
      return String(
        response.response || "I'm sorry, but I couldn't generate a response at this time.",
      );
    }
  } else if (
    response &&
    typeof response === 'object' &&
    'body' in response &&
    response.body &&
    typeof response.body === 'object' &&
    'response' in response.body
  ) {
    // Handle nested response structure
    return String(response.body.response);
  }

  // If we get here, we have an unexpected response format
  // Return a fallback message instead of the raw response
  return "I'm sorry, but I couldn't generate a response at this time. The service may be experiencing issues.";
}
