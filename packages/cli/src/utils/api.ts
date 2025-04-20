import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { loadConfig, isAuthenticated } from './config';

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
    tags: tags || undefined
  };
  
  const response = await api.post('/notes/ingest', payload);
  return response.note || response;
}

/**
 * Start or append to a note session
 * @param context The context for the note
 * @param content The content to add
 * @returns The response data
 */
export async function addNote(context: string, content: string): Promise<any> {
  // The new API doesn't have a direct equivalent to the old /note/:context endpoint
  // Instead, we'll use the /notes/ingest endpoint with the context as metadata
  return api.post('/notes/ingest', {
    content,
    contentType: 'text/plain',
    metadata: { context }
  });
}

/**
 * List notes or tasks
 * @param type The type of items to list ('notes' or 'tasks')
 * @param filter Optional filter criteria
 * @returns The response data
 */
export async function listItems(type: 'notes' | 'tasks', filter?: string): Promise<any> {
  const params: Record<string, any> = {};
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
  
  // Return the items array from the response
  if (type === 'notes') {
    return response.notes || [];
  } else {
    return response.tasks || [];
  }
}

/**
 * List notes
 * @param filter Optional filter criteria
 * @returns The response data with notes
 */
export async function listNotes(filter?: string): Promise<any[]> {
  return listItems('notes', filter);
}

/**
 * List tasks
 * @param filter Optional filter criteria
 * @returns The response data with tasks
 */
export async function listTasks(filter?: string): Promise<any[]> {
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
 * Search across stored content
 * @param query The search query
 * @returns The response data
 */
export async function search(query: string, limit: number = 10): Promise<any> {
  const params = {
    q: query,
    limit
  };
  
  const response = await api.get('/notes/search', { params });
  return {
    results: response.results || [],
    pagination: response.pagination || { total: 0, limit, offset: 0, hasMore: false },
    query
  };
}

/**
 * Chat with the RAG-enhanced interface
 * @param message The message to send
 * @returns The response data
 */
export async function chat(message: string): Promise<any> {
  // The new chat API expects a messages array with role and content
  const payload = {
    messages: [
      {
        role: 'user',
        content: message
      }
    ],
    stream: false,
    enhanceWithContext: true,
    maxContextItems: 5,
    includeSourceInfo: true
  };
  
  const response = await api.post('/chat', payload);
  return response.response || response;
}
