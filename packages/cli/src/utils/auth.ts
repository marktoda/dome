import { api } from './api';
import { saveApiKey } from './config';
import axios, { AxiosError } from 'axios';

// Define interfaces for API responses
interface AuthResponse {
  success: boolean;
  token?: string;
  user?: {
    id: string;
    email: string;
    name: string;
  };
  error?: {
    code: string | number;
    message: string;
  };
}

/**
 * Register a new user with the dome API
 * @param email User email
 * @param password User password
 * @param name User name
 * @returns Registration result with token if successful
 */
export async function registerUser(
  email: string,
  password: string,
  name: string,
): Promise<AuthResponse> {
  try {
    const apiResponse = await api.post('/auth/register', {
      email,
      password,
      name,
    }) as any;

    // Based on debug logs, apiResponse is { "token": "..." }
    if (apiResponse && apiResponse.token) {
      return {
        success: true,
        token: apiResponse.token,
        // User info is not present in this flat structure from debug logs
        user: apiResponse.user, // Keep this in case user info is sometimes present
      };
    } else {
      return {
        success: false,
        error: {
          code: 'REGISTRATION_ERROR',
          message: apiResponse?.error?.message || 'Registration failed to return a token.',
        },
      };
    }
  } catch (error: unknown) {
    // Handle different error scenarios
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      // Server responded with an error
      if (axiosError.response) {
        const responseData = axiosError.response.data as any;
        return {
          success: false,
          error: {
            code: axiosError.response.status,
            message: responseData?.error?.message || 'Registration failed',
          },
        };
      } else if (axiosError.request) {
        // Request was made but no response received
        return {
          success: false,
          error: {
            code: 'NETWORK_ERROR',
            message: 'No response from server. Please check your connection.',
          },
        };
      }
    }

    // Something else went wrong
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error during registration';
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: errorMessage,
      },
    };
  }
}

/**
 * Login a user with the dome API
 * @param email User email
 * @param password User password
 * @returns Login result with token if successful
 */
export async function loginUser(email: string, password: string): Promise<AuthResponse> {
  try {
    const apiResponse = await api.post('/auth/login', {
      email,
      password,
    }) as any;

    // Based on debug logs, apiResponse is { "token": "..." }
    if (apiResponse && apiResponse.token) {
      return {
        success: true,
        token: apiResponse.token,
        // User info is not present in this flat structure from debug logs
        user: apiResponse.user, // Keep this in case user info is sometimes present
      };
    } else {
      return {
        success: false,
        error: {
          code: 'LOGIN_ERROR',
          message: apiResponse?.error?.message || 'Login failed to return a token.',
        },
      };
    }
  } catch (error: unknown) {
    // Handle different error scenarios
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      // Server responded with an error
      if (axiosError.response) {
        const responseData = axiosError.response.data as any;
        return {
          success: false,
          error: {
            code: axiosError.response.status,
            message: responseData?.error?.message || 'Login failed',
          },
        };
      } else if (axiosError.request) {
        // Request was made but no response received
        return {
          success: false,
          error: {
            code: 'NETWORK_ERROR',
            message: 'No response from server. Please check your connection.',
          },
        };
      }
    }

    // Something else went wrong
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during login';
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: errorMessage,
      },
    };
  }
}

/**
 * Save the authentication token from a successful login/registration
 * @param result The result from login or registration
 * @returns True if token was saved successfully
 */
export function saveAuthToken(result: AuthResponse): boolean {
  if (result && result.success && result.token) {
    saveApiKey(result.token);
    return true;
  }
  return false;
}

