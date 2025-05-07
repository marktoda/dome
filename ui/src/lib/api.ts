import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
// import { getSession } from 'next-auth/react'; // Assuming next-auth for session management - REMOVED

// Function to get the API base URL from environment variables
const getApiBaseUrl = (): string => {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!baseUrl) {
    // Fallback to relative path if no explicit base URL is set
    // This works if the Next.js app and the API are on the same domain
    return '/api';
  }
  return baseUrl;
};

class ApiClient {
  private axiosInstance: AxiosInstance;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: getApiBaseUrl(),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.axiosInstance.interceptors.request.use(
      config => {
        // Attempt to get the token from localStorage
        if (typeof window !== 'undefined') {
          const token = localStorage.getItem('token');
          if (token) {
            config.headers.Authorization = `Bearer ${token}`;
          }
        }
        return config;
      },
      error => {
        return Promise.reject(error);
      },
    );
  }

  public async request<T = unknown>( // Changed T default from any to unknown
    method: 'get' | 'post' | 'put' | 'delete' | 'patch',
    url: string,
    dataOrParams?: unknown, // Changed any to unknown
    config?: AxiosRequestConfig, // AxiosRequestConfig is already well-typed
  ): Promise<T> {
    let response;
    if (method === 'get' || method === 'delete') {
      response = await this.axiosInstance[method]<T>(url, { params: dataOrParams, ...config });
    } else {
      response = await this.axiosInstance[method]<T>(url, dataOrParams, config);
    }
    return response.data;
  }

  public get<T = unknown>(url: string, params?: unknown, config?: AxiosRequestConfig): Promise<T> {
    // Changed T default and params type
    return this.request<T>('get', url, params, config);
  }

  public post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    // Changed T default and data type
    return this.request<T>('post', url, data, config);
  }

  public put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    // Changed T default and data type
    return this.request<T>('put', url, data, config);
  }

  public delete<T = unknown>(
    url: string,
    params?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    // Changed T default and params type
    return this.request<T>('delete', url, params, config);
  }

  public patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    // Changed T default and data type
    return this.request<T>('patch', url, data, config);
  }
}

const apiClient = new ApiClient();

export default apiClient;

// Example search function using the apiClient
import { SearchResponse } from '@/lib/types/search'; // Removed unused SearchResultItem

// Define the structure for customMetadata based on the API response
export interface CustomMetadata {
  repository?: string;
  path?: string;
  commitSha?: string;
  commitMessage?: string;
  author?: string;
  authorEmail?: string;
  commitDate?: string; // ISO date string
  htmlUrl?: string;
  tags?: string[]; // Added to allow for tags if they appear in customMetadata
  [key: string]: unknown; // Changed any to unknown
}

// Define the Note type based on the provided API response structure
export interface Note {
  id: string;
  userId: string;
  category: string;
  mimeType: string;
  size: number;
  r2Key: string;
  sha256: string | null;
  createdAt: number; // Timestamp
  version: number;
  title: string;
  summary?: string;
  body?: string;
  customMetadata?: CustomMetadata;
  // If SearchResultItem fields like 'url' were previously relied upon directly on Note,
  // they should now be sourced from the appropriate place (e.g. customMetadata.htmlUrl)
  // or explicitly added if they are part of the note object from a different source.
}

// Interface for the API response wrapper for getNoteById
export interface ApiGetNoteByIdResponse {
  success: boolean;
  note: Note;
}

export const searchApi = {
  search: (query: string, category?: string): Promise<SearchResponse> => {
    const params: Record<string, string> = { q: query }; // Changed Record value from any to string
    if (category) {
      params.category = category;
    }
    return apiClient.get<SearchResponse>('/search', params);
  },
};

export const notesApi = {
  getNoteById: async (id: string): Promise<Note> => {
    // The actual backend endpoint might be different, e.g., /notes/:id
    // This assumes the API returns a structure like { success: true, note: { ... } }
    const response = await apiClient.get<ApiGetNoteByIdResponse>(`/notes/${id}`);
    if (response && response.success && response.note) {
      return response.note;
    }
    // Handle cases where response is not as expected or success is false
    const errorMessage = response?.note
      ? 'API request to get note by ID was not successful.'
      : 'Invalid API response structure for getNoteById.';
    console.error(errorMessage, response);
    throw new Error(errorMessage);
  },
};
