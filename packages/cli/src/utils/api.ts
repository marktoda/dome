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
export async function addContent(content: string): Promise<any> {
  return api.post('/notes/ingest', { content });
}

/**
 * Start or append to a note session
 * @param context The context for the note
 * @param content The content to add
 * @returns The response data
 */
export async function addNote(context: string, content: string): Promise<any> {
  return api.post(`/note/${context}`, { content });
}

/**
 * List notes or tasks
 * @param type The type of items to list ('notes' or 'tasks')
 * @param filter Optional filter criteria
 * @returns The response data
 */
export async function listItems(type: 'notes' | 'tasks', filter?: string): Promise<any> {
  const params: Record<string, string> = {};
  if (filter) {
    params.filter = filter;
  }
  // Use the correct endpoint based on type
  const endpoint = type === 'notes' ? '/notes' : '/tasks';
  return api.get(endpoint, { params });
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
  return api.get(`/notes/${id}`);
}

/**
 * Search across stored content
 * @param query The search query
 * @returns The response data
 */
export async function search(query: string): Promise<any> {
  return api.get('/notes/search', { params: { q: query } });
}

/**
 * Chat with the RAG-enhanced interface
 * @param message The message to send
 * @returns The response data
 */
export async function chat(message: string): Promise<any> {
  return api.post('/chat', { message });
}
