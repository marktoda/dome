import axios, { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

// It's generally better to import this from a shared constants file or AuthContext,
// but for this focused change, we'll define it here. Ensure it matches AuthContext.tsx.
const TOKEN_STORAGE_KEY = 'authToken';

/**
 * Retrieves the API base URL from environment variables.
 * Falls back to a relative '/api' path if `NEXT_PUBLIC_API_BASE_URL` is not set,
 * assuming the Next.js app and API share the same domain.
 * @returns The base URL string for API requests.
 */
const getApiBaseUrl = (): string => {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!baseUrl) {
    console.warn('NEXT_PUBLIC_API_BASE_URL not set, falling back to relative /api path.');
    return '/api';
  }
  return baseUrl;
};

/**
 * `ApiClient` provides a wrapper around Axios for making HTTP requests to the backend API.
 * It includes base configuration, an interceptor to add the Authorization header,
 * and a response interceptor for basic error handling (specifically 401/403).
 */
class ApiClient {
  private axiosInstance: AxiosInstance;

  /**
   * Creates an instance of ApiClient.
   * Initializes Axios with base URL, headers, and interceptors.
   */
  constructor() {
    this.axiosInstance = axios.create({
      baseURL: getApiBaseUrl(),
      headers: {
        'Content-Type': 'application/json',
      },
      // withCredentials: true, // Removed as we are using Bearer tokens
    });

    // Request interceptor to add the Authorization header
    this.axiosInstance.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        // Check if localStorage is available
        if (typeof window !== 'undefined' && window.localStorage) {
          const token = localStorage.getItem(TOKEN_STORAGE_KEY);
          console.debug('api.ts: Interceptor attempting to get token. Found:', token);

          // Ensure token is valid before attaching
          if (token && token !== 'undefined' && token.trim() !== '') {
            config.headers.Authorization = `Bearer ${token}`;
            console.debug('api.ts: Authorization header set with token.');
          } else {
            if (token) { // Log if token exists but is invalid (e.g. "undefined" string)
                 console.warn(`api.ts: Invalid token found in localStorage ('${token}'). Authorization header NOT set.`);
            } else {
                 console.debug('api.ts: No token found in localStorage. Authorization header NOT set.');
            }
            // Do not set Authorization header if token is invalid or missing
            // Consider removing the invalid token from localStorage here if appropriate,
            // though AuthContext also handles this.
            // delete config.headers.Authorization; // Ensure it's not set from a previous bad state if Axios reuses config objects
          }
        } else {
          console.debug('api.ts: localStorage not available. Authorization header NOT set.');
        }
        return config;
      },
      error => {
        return Promise.reject(error);
      },
    );

    // Response interceptor for handling common errors globally
    this.axiosInstance.interceptors.response.use(
      response => response, // Pass through successful responses
      error => {
        // Handle common authentication/authorization errors
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
          const requestUrl = error.config?.url || 'Unknown URL';
          const requestMethod = error.config?.method?.toUpperCase() || 'Unknown Method';
          console.error(
            `api.ts: API Request to ${requestMethod} ${requestUrl} resulted in ${error.response.status}. Message:`,
            error.response.data?.message || error.response.data || 'No specific error message.'
          );

          if (error.response.status === 401) {
            console.warn('api.ts: Received 401 Unauthorized. This could be due to an invalid/expired token or missing token.');
            // AuthContext's initializeAuth or a dedicated event listener should handle global logout/redirect.
            // For example, dispatching an event that AuthContext listens to:
            if (typeof window !== 'undefined') {
              // window.dispatchEvent(new CustomEvent('authError', { detail: { status: 401 } }));
              // Consider if removing the token here is the right place, or if AuthContext should own it.
              // If the token is definitively bad, removing it here can prevent further failed requests.
              // const currentToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
              // if (currentToken) {
              //   console.log('api.ts: Removing potentially invalid token from localStorage due to 401.');
              //   window.localStorage.removeItem(TOKEN_STORAGE_KEY);
              // }
            }
          }
        } else if (error.request) {
          // Handle network errors (request made but no response received)
          console.error('API Network Error:', error.config.url, error.message);
        } else {
          // Handle other errors (e.g., setup errors)
          console.error('API Request Error:', error.message);
        }
        // Important: Re-throw the error so calling code can handle it specifically if needed
        return Promise.reject(error);
      },
    );
  }

  /**
   * Generic method to make an API request.
   * @template T The expected type of the response data.
   * @param method The HTTP method (get, post, put, delete, patch).
   * @param url The endpoint URL (relative to the base URL).
   * @param dataOrParams Optional data for the request body (for POST, PUT, PATCH) or query parameters (for GET, DELETE).
   * @param config Optional additional Axios request configuration.
   * @returns A promise resolving to the response data of type T.
   */
  public async request<T = unknown>(
    method: 'get' | 'post' | 'put' | 'delete' | 'patch',
    url: string,
    dataOrParams?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    let response;
    try {
      if (method === 'get' || method === 'delete') {
        response = await this.axiosInstance[method]<T>(url, { params: dataOrParams, ...config });
      } else {
        response = await this.axiosInstance[method]<T>(url, dataOrParams, config);
      }
      return response.data;
    } catch (error) {
      // The interceptor already logged the error, but we re-throw it
      // so that the calling function can also catch it if needed.
      throw error;
    }
  }

  /**
   * Performs a GET request.
   * @template T Expected response data type.
   * @param url Endpoint URL.
   * @param params Optional query parameters.
   * @param config Optional Axios configuration.
   * @returns Promise resolving to response data.
   */
  public get<T = unknown>(url: string, params?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>('get', url, params, config);
  }

  /**
   * Performs a POST request.
   * @template T Expected response data type.
   * @param url Endpoint URL.
   * @param data Optional request body data.
   * @param config Optional Axios configuration.
   * @returns Promise resolving to response data.
   */
  public post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>('post', url, data, config);
  }

  /**
   * Performs a PUT request.
   * @template T Expected response data type.
   * @param url Endpoint URL.
   * @param data Optional request body data.
   * @param config Optional Axios configuration.
   * @returns Promise resolving to response data.
   */
  public put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>('put', url, data, config);
  }

  /**
   * Performs a DELETE request.
   * @template T Expected response data type.
   * @param url Endpoint URL.
   * @param params Optional query parameters.
   * @param config Optional Axios configuration.
   * @returns Promise resolving to response data.
   */
  public delete<T = unknown>(
    url: string,
    params?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>('delete', url, params, config);
  }

  /**
   * Performs a PATCH request.
   * @template T Expected response data type.
   * @param url Endpoint URL.
   * @param data Optional request body data.
   * @param config Optional Axios configuration.
   * @returns Promise resolving to response data.
   */
  public patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>('patch', url, data, config);
  }
}

/**
 * Singleton instance of the ApiClient for making API requests throughout the application.
 */
const apiClient = new ApiClient();

export default apiClient;

// ========================================================================
// Specific API Function Groups
// ========================================================================

import { SearchResponse } from '@/lib/types/search';

/**
 * Represents custom metadata associated with a Note, often from source control like Git.
 */
export interface CustomMetadata {
  repository?: string;
  path?: string;
  commitSha?: string;
  commitMessage?: string;
  author?: string;
  authorEmail?: string;
  commitDate?: string; // ISO date string
  htmlUrl?: string;
  tags?: string[];
  /** Allows for other potential metadata fields. */
  [key: string]: unknown;
}

/**
 * Represents the structure of a Note object as returned by the API.
 */
export interface Note {
  id: string;
  userId: string;
  category: string;
  mimeType: string;
  size: number;
  r2Key: string;
  sha256: string | null;
  createdAt: number; // Unix timestamp or similar numeric representation
  version: number;
  title: string;
  summary?: string;
  body?: string;
  customMetadata?: CustomMetadata;
}

/**
 * Expected structure of the API response when fetching a single note by ID.
 */
export interface ApiGetNoteByIdResponse {
  success: boolean;
  note: Note;
}

/**
 * Collection of API functions related to search operations.
 */
export const searchApi = {
  /**
   * Performs a search query against the backend.
   * @param query - The search term.
   * @param category - Optional category to filter search results.
   * @returns A promise resolving to the search response containing results.
   */
  search: (query: string, category?: string): Promise<SearchResponse> => {
    const params: Record<string, string> = { q: query };
    if (category) {
      params.category = category;
    }
    return apiClient.get<SearchResponse>('/search', params);
  },
};

/**
 * Collection of API functions related to notes.
 */
export const notesApi = {
  /**
   * Fetches a single note by its unique identifier.
   * @param id - The ID of the note to fetch.
   * @returns A promise resolving to the Note object.
   * @throws Throws an error if the API request fails or the response structure is invalid.
   */
  getNoteById: async (id: string): Promise<Note> => {
    // Assuming the endpoint is /notes/:id
    const response = await apiClient.get<ApiGetNoteByIdResponse>(`/notes/${id}`);
    if (response?.success && response.note) {
      return response.note;
    }
    // Handle cases where response is not as expected or success is false
    const errorMessage = response?.success === false
      ? `API request to get note ${id} failed.`
      : `Invalid API response structure when fetching note ${id}.`;
    console.error(errorMessage, 'Response:', response);
    throw new Error(errorMessage);
  },
};
