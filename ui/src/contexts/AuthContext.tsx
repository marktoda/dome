'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import apiClient from '@/lib/api'; // Import the configured apiClient

const TOKEN_STORAGE_KEY = 'authToken';

/**
 * Represents the structure of a user object.
 */
interface User {
  id: string;
  name: string;
  email: string;
}

/**
 * Defines the shape of the authentication context.
 */
interface AuthContextType {
  /** The currently authenticated user, or null if no user is authenticated. */
  user: User | null;
  /** The authentication token, or null if not authenticated. */
  token: string | null;
  /** Indicates if the authentication status is currently being loaded (e.g., on initial app load). */
  isLoading: boolean;
  /**
   * Updates the client-side user and token state after a successful login.
   * @param userData The user data received after successful login.
   * @param token The authentication token received after successful login.
   */
  login: (userData: User, token: string) => void;
  /**
   * Logs out the current user by clearing client-side state and token,
   * and calling the backend `/api/auth/logout` endpoint.
   */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Provides authentication state (`user`, `token`, `isLoading`) and functions (`login`, `logout`)
 * to its children components via React Context.
 *
 * It handles initializing authentication state on load by checking for a stored token
 * and fetching user details.
 * Login stores the token and user data.
 * Logout clears the token and user data, and calls the backend logout endpoint.
 *
 * @param props - The props for the component.
 * @param props.children - The child components that will consume the context.
 * @example
 * ```tsx
 * // In your main layout or app entry point
 * import { AuthProvider } from '@/contexts/AuthContext';
 *
 * function App({ children }) {
 *   return (
 *     <AuthProvider>
 *       {children}
 *     </AuthProvider>
 *   );
 * }
 * ```
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    /**
     * Initializes authentication state by checking for a stored token
     * and fetching user details if a token exists.
     */
    const initializeAuth = async () => {
      setIsLoading(true);
      const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);

      if (storedToken && storedToken !== 'undefined' && storedToken.trim() !== '') {
        console.log('AuthContext: Found stored token:', storedToken);
        setToken(storedToken);
        try {
          // Attempt to fetch user data using the stored token
          console.debug('AuthContext: Attempting to validate token and fetch user with /auth/me');
          const response = await apiClient.get<{ user: User }>('/auth/me');
          if (response && response.user) {
            setUser(response.user);
            console.log('AuthContext: User session restored successfully.');
          } else {
            console.warn('AuthContext: /auth/me response malformed or no user data. Invalidating local token.');
            localStorage.removeItem(TOKEN_STORAGE_KEY);
            setToken(null);
            setUser(null);
          }
        } catch (error: any) {
          console.warn('AuthContext: Error validating token or fetching user data with stored token.');
          if (error.response?.status === 401 || error.response?.status === 403) {
            console.log('AuthContext: Token validation failed (401/403). Invalid or expired token.');
          } else {
            console.error('AuthContext: Error details:', error.message || error);
          }
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken(null);
          setUser(null);
        }
      } else {
        if (storedToken === 'undefined' || (storedToken && storedToken.trim() === '')) {
          console.warn(`AuthContext: Found invalid stored token ('${storedToken}'). Removing it.`);
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        } else {
          console.log('AuthContext: No valid stored token found.');
        }
        setToken(null); // Ensure token state is null if no valid token
        setUser(null);  // Ensure user state is null
      }
      setIsLoading(false);
    };

    initializeAuth();
  }, []); // Run only once on mount

  /**
   * Updates client-side user and token state after a successful login.
   * Stores the token in localStorage.
   * @param userData - The user data obtained from the successful login response.
   * @param authToken - The authentication token.
   */
  const login = (userData: User, authToken: string) => {
    if (typeof authToken === 'string' && authToken.trim() !== '' && authToken !== 'undefined') {
      localStorage.setItem(TOKEN_STORAGE_KEY, authToken);
      setToken(authToken);
      setUser(userData);
      console.log('AuthContext: User logged in, token stored:', authToken);
    } else {
      console.error('AuthContext: Attempted to login with an invalid token:', authToken);
      // Optionally, clear any potentially bad state if an invalid token is provided
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      setToken(null);
      setUser(null);
    }
  };

  /**
   * Logs out the user. Clears client-side user state and token from localStorage.
   * Calls the backend logout endpoint.
   * @returns A promise that resolves when the logout attempt is complete.
   */
  const logout = async () => {
    setIsLoading(true);
    const currentToken = token; // Use state token for the logout API call

    // Clear local state and storage first
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
    console.log('Local token and user state cleared.');

    if (currentToken) {
      try {
        // The apiClient should now be configured to send the token
        await apiClient.post('/auth/logout', {}); // Backend might invalidate the token
        console.log('Logout successful (API call to /auth/logout succeeded).');
      } catch (error: any) {
        console.error('Logout API call failed:', error.message || error);
        // Even if API fails, client-side logout is done.
        // Backend token might remain valid until expiry if API call fails.
      }
    } else {
        console.log('No active token to invalidate on backend during logout.');
    }
    setIsLoading(false);
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

/**
 * Custom hook `useAuth` provides an easy way to access the authentication context values.
 *
 * @returns The authentication context containing `user`, `isLoading`, `login`, and `logout`.
 * @throws Throws an error if used outside of an `AuthProvider` tree.
 * @example
 * ```tsx
 * import { useAuth } from '@/contexts/AuthContext';
 *
 * function UserProfile() {
 *   const { user, logout, isLoading } = useAuth();
 *
 *   if (isLoading) return <p>Loading...</p>;
 *   if (!user) return <p>Please log in.</p>;
 *
 *   return (
 *     <div>
 *       <p>Welcome, {user.name}!</p>
 *       <button onClick={logout}>Logout</button>
 *     </div>
 *   );
 * }
 * ```
 */
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};