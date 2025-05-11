import axios, { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig, AxiosError } from 'axios';
import { SearchResponse as AppSearchResponse, SearchResultItem as AppSearchResultItem } from '@/lib/types/search'; // Import centralized types

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
 * Represents structured data that might be present in an API error response.
 */
export interface ApiErrorResponseData {
  message?: string;
  errors?: Array<{ field?: string; message: string }>;
  [key: string]: any; // For other potential error details
}

/**
 * Custom error class for API-related errors.
 * Provides more structured information about HTTP errors.
 */
export class ApiError extends Error {
  public readonly status?: number;
  public readonly data?: ApiErrorResponseData | any;
  public readonly requestUrl?: string;
  public readonly requestMethod?: string;

  /**
   * Creates an instance of ApiError.
   * @param message - The error message.
   * @param status - Optional HTTP status code.
   * @param data - Optional data payload from the error response.
   * @param requestUrl - Optional URL of the failed request.
   * @param requestMethod - Optional HTTP method of the failed request.
   */
  constructor(
    message: string,
    status?: number,
    data?: ApiErrorResponseData | any,
    requestUrl?: string,
    requestMethod?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.requestUrl = requestUrl;
    this.requestMethod = requestMethod;
    // Set the prototype explicitly to ensure instanceof works correctly.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * `ApiClient` provides a wrapper around Axios for making HTTP requests to the backend API.
 * It includes base configuration, an interceptor to add the Authorization header,
 * and a response interceptor for structured error handling.
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
    });

    // Request interceptor to add the Authorization header
    this.axiosInstance.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        if (typeof window !== 'undefined' && window.localStorage) {
          const token = localStorage.getItem(TOKEN_STORAGE_KEY);
          console.debug('api.ts: Interceptor attempting to get token. Found:', token ? 'yes' : 'no');

          if (token && token !== 'undefined' && token.trim() !== '') {
            config.headers.Authorization = `Bearer ${token}`;
            console.debug('api.ts: Authorization header set.');
          } else {
            if (token) {
                 console.warn(`api.ts: Invalid token found in localStorage ('${token}'). Authorization header NOT set.`);
            } else {
                 console.debug('api.ts: No token found in localStorage. Authorization header NOT set.');
            }
          }
        } else {
          console.debug('api.ts: localStorage not available. Authorization header NOT set.');
        }
        return config;
      },
      error => {
        // Errors during request setup will be caught here.
        // These are less common but should be converted to ApiError for consistency.
        console.error('API Request Setup Error (interceptor):', error.message);
        return Promise.reject(new ApiError(error.message || 'Request setup error.'));
      },
    );

    // Response interceptor for handling errors globally and transforming them into ApiError
    this.axiosInstance.interceptors.response.use(
      response => response, // Pass through successful responses
      (error: AxiosError) => {
        const requestUrl = error.config?.url || 'Unknown URL';
        const requestMethod = error.config?.method?.toUpperCase() || 'Unknown Method';

        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          const { status, data } = error.response;
          const errorMessage = (data as ApiErrorResponseData)?.message || error.message || `Request failed with status code ${status}`;
          
          console.error(
            `api.ts: API Request to ${requestMethod} ${requestUrl} resulted in ${status}. Message:`,
            (data as ApiErrorResponseData)?.message || data || 'No specific error message.'
          );

          if (status === 401) {
            console.warn('api.ts: Received 401 Unauthorized. This could be due to an invalid/expired token or missing token.');
            // AuthContext or a global event listener should handle logout/redirect.
            // Example: window.dispatchEvent(new CustomEvent('authError', { detail: { status: 401 } }));
          }
          // Other specific status handling (e.g., 403, 404) can be added here if needed.

          throw new ApiError(errorMessage, status, data, requestUrl, requestMethod);
        } else if (error.request) {
          // The request was made but no response was received (e.g., network error)
          console.error(`API Network Error: No response received for ${requestMethod} ${requestUrl}`, error.message);
          throw new ApiError(
            error.message || 'Network error: No response received.',
            undefined, // No HTTP status for such errors
            undefined,
            requestUrl,
            requestMethod
          );
        } else {
          // Something happened in setting up the request that triggered an Error (should be rare if request interceptor handles it)
          console.error('API Request Error (unknown type):', error.message);
          throw new ApiError(
            error.message || 'An unexpected error occurred during the API request.',
            undefined,
            undefined,
            requestUrl,
            requestMethod
          );
        }
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
   * @throws {ApiError} If the request fails.
   */
  public async request<T = unknown>(
    method: 'get' | 'post' | 'put' | 'delete' | 'patch',
    url: string,
    dataOrParams?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    try {
      let response;
      if (method === 'get' || method === 'delete') {
        response = await this.axiosInstance[method]<T>(url, { params: dataOrParams, ...config });
      } else {
        response = await this.axiosInstance[method]<T>(url, dataOrParams, config);
      }
      return response.data;
    } catch (error) {
      // If the error is already an ApiError (thrown by the interceptor), re-throw it.
      // Otherwise, wrap it, though the interceptor should catch most cases.
      if (error instanceof ApiError) {
        throw error;
      }
      // This path should ideally not be hit if interceptors are comprehensive.
      console.error('api.ts: Unhandled error in request method, wrapping:', error);
      throw new ApiError(
        (error as Error).message || 'An unexpected error occurred.',
        (error as AxiosError).response?.status,
        (error as AxiosError).response?.data,
        config?.url || url,
        method.toUpperCase()
      );
    }
  }

  /**
   * Performs a GET request.
   * @template T Expected response data type.
   * @param url Endpoint URL.
   * @param params Optional query parameters.
   * @param config Optional Axios configuration.
   * @returns Promise resolving to response data.
   * @throws {ApiError} If the request fails.
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
   * @throws {ApiError} If the request fails.
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
   * @throws {ApiError} If the request fails.
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
   * @throws {ApiError} If the request fails.
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
   * @throws {ApiError} If the request fails.
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
// Specific API Function Groups (Example Usage)
// ========================================================================

// Local SearchResultItem and SearchResponse are removed, using imported AppSearchResponse and AppSearchResultItem

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
 * Expected structure of the API response when fetching a single note by ID,
 * assuming the API wraps the note in a success object.
 */
export interface ApiGetNoteByIdResponse {
  success: boolean;
  note: Note;
  message?: string; // Optional message from API on failure
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
   * @throws {ApiError} If the API request fails.
   */
  search: async (query: string, category?: string): Promise<AppSearchResponse> => {
    const params: Record<string, string> = { q: query };
    if (category) {
      params.category = category;
    }
    // Assuming the actual API returns SearchResultItem with 'snippet'
    // We need to fetch this and then map it to AppSearchResultItem which expects 'description'
    const response = await apiClient.get<{ results: { id: string; title: string; snippet: string; url?: string; category?: string }[], total: number, query: string }>('/search', params);
    
    const mappedResults: AppSearchResultItem[] = response.results.map(item => ({
      ...item,
      description: item.snippet, // Map snippet to description
    }));

    return {
      ...response,
      results: mappedResults,
    };
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
   * @throws {ApiError} If the API request fails or the response indicates an application-level error.
   */
  getNoteById: async (id: string): Promise<Note> => {
    // apiClient.get will throw an ApiError for HTTP status codes like 404, 500, etc.
    const response = await apiClient.get<ApiGetNoteByIdResponse>(`/notes/${id}`);

    // Handle cases where the HTTP request was successful (e.g., 200 OK),
    // but the application-level response indicates failure (e.g., { success: false }).
    if (response?.success && response.note) {
      return response.note;
    }
    
    const errorMessage = response?.message || 
                         (response?.success === false 
                           ? `API request to get note ${id} failed (application-level).`
                           : `Invalid API response structure when fetching note ${id}.`);
    
    console.error(errorMessage, 'Full Response:', response);
    // Throw an ApiError for consistency, providing details from the application-level response.
    throw new ApiError(
        errorMessage,
        200, // Assuming 200 OK if response object exists but indicates logical failure
        response, // The full response data can be useful for debugging
        `/notes/${id}`,
        'GET'
    );
  },
};
