'use client';

import React, { createContext, useContext, useEffect, useReducer, ReactNode, useCallback } from 'react';

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
 * Defines the shape of the authentication state.
 */
interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Defines the actions that can be dispatched to update the authentication state.
 */
type AuthAction =
  | { type: 'INITIALIZE_START' }
  | { type: 'INITIALIZE_SUCCESS'; payload: { user: User | null; token: string | null } }
  | { type: 'INITIALIZE_FAILURE'; payload: { error: string } }
  | { type: 'LOGIN_SUCCESS'; payload: { user: User; token: string } }
  | { type: 'LOGOUT_START' }
  | { type: 'LOGOUT_SUCCESS' }
  | { type: 'LOGOUT_FAILURE'; payload: { error: string } }
  | { type: 'CLEAR_ERROR' };

/**
 * Defines the shape of the authentication context.
 */
interface AuthContextType extends AuthState {
  login: (userData: User, token: string) => void;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: true,
  error: null,
};

/**
 * Reducer function to manage authentication state transitions.
 * @param state - The current authentication state.
 * @param action - The action to perform.
 * @returns The new authentication state.
 */
const authReducer = (state: AuthState, action: AuthAction): AuthState => {
  switch (action.type) {
    case 'INITIALIZE_START':
      return { ...state, isLoading: true, error: null };
    case 'INITIALIZE_SUCCESS':
      return {
        ...state,
        isLoading: false,
        user: action.payload.user,
        token: action.payload.token,
        error: null,
      };
    case 'INITIALIZE_FAILURE':
      return {
        ...state,
        isLoading: false,
        user: null,
        token: null,
        error: action.payload.error,
      };
    case 'LOGIN_SUCCESS':
      return {
        ...state,
        isLoading: false,
        user: action.payload.user,
        token: action.payload.token,
        error: null,
      };
    case 'LOGOUT_START':
      return { ...state, isLoading: true, error: null };
    case 'LOGOUT_SUCCESS':
      return { ...initialState, isLoading: false }; // Reset to initial on logout
    case 'LOGOUT_FAILURE':
      // Keep user/token null even if logout API fails, as local logout already happened.
      return { ...state, isLoading: false, user: null, token: null, error: action.payload.error };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
};

/**
 * Provides authentication state and functions to its children components.
 * Uses a reducer for state management and handles token storage and validation.
 * @param props - The props for the component.
 * @param props.children - The child components that will consume the context.
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(authReducer, initialState);

  useEffect(() => {
    const initializeAuth = async () => {
      dispatch({ type: 'INITIALIZE_START' });
      const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);

      if (storedToken && storedToken !== 'undefined' && storedToken.trim() !== '') {
        console.log('AuthContext: Found stored token.');
        try {
          console.debug('AuthContext: Attempting to validate token and fetch user with /api/auth/me');
          const fetchOptions: RequestInit = {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${storedToken}`,
            },
          };
          const res = await fetch('/api/auth/me', fetchOptions);

          if (res.ok) {
            const data = await res.json();
            if (data && data.user) {
              dispatch({ type: 'INITIALIZE_SUCCESS', payload: { user: data.user, token: storedToken } });
              console.log('AuthContext: User session restored successfully.');
            } else {
              localStorage.removeItem(TOKEN_STORAGE_KEY);
              dispatch({ type: 'INITIALIZE_FAILURE', payload: { error: 'User data not found in /me response.' } });
              console.warn('AuthContext: /api/auth/me response malformed. Invalidating local token.');
            }
          } else {
            localStorage.removeItem(TOKEN_STORAGE_KEY);
            const errorMsg = `/api/auth/me request failed with status ${res.status}.`;
            dispatch({ type: 'INITIALIZE_FAILURE', payload: { error: errorMsg } });
            console.warn(`AuthContext: ${errorMsg} Invalidating local token.`);
          }
        } catch (error: any) {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          const errorMsg = `Network or other error fetching user data: ${error.message || String(error)}`;
          dispatch({ type: 'INITIALIZE_FAILURE', payload: { error: errorMsg } });
          console.error(`AuthContext: ${errorMsg}`);
        }
      } else {
        if (storedToken === 'undefined' || (storedToken && storedToken.trim() === '')) {
          console.warn(`AuthContext: Found invalid stored token ('${storedToken}'). Removing it.`);
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        } else {
          console.log('AuthContext: No valid stored token found.');
        }
        dispatch({ type: 'INITIALIZE_FAILURE', payload: { error: 'No valid token found.' } }); // No user, no token
      }
    };

    initializeAuth();
  }, []);

  const login = useCallback((userData: User, authToken: string) => {
    if (typeof authToken === 'string' && authToken.trim() !== '' && authToken !== 'undefined') {
      localStorage.setItem(TOKEN_STORAGE_KEY, authToken);
      dispatch({ type: 'LOGIN_SUCCESS', payload: { user: userData, token: authToken } });
      console.log('AuthContext: User logged in, token stored.');
    } else {
      console.error('AuthContext: Attempted to login with an invalid token:', authToken);
      localStorage.removeItem(TOKEN_STORAGE_KEY); // Ensure clean state
      // Potentially dispatch a LOGIN_FAILURE action if defined, or set an error
      // For now, we rely on the calling code to handle UI for login form errors.
      // This login function is more about setting state post-successful external login.
    }
  }, []);

  const logout = useCallback(async () => {
    dispatch({ type: 'LOGOUT_START' });
    const currentToken = state.token; // Use token from state

    localStorage.removeItem(TOKEN_STORAGE_KEY);
    console.log('AuthContext: Local token and user state cleared for logout.');

    // Optimistically update local state before API call completes
    // The reducer handles setting user/token to null on LOGOUT_SUCCESS or LOGOUT_FAILURE

    if (currentToken) {
      try {
        const fetchOptions: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken}`,
          },
          body: JSON.stringify({}),
        };
        const res = await fetch('/api/auth/logout', fetchOptions);
        if (res.ok) {
          dispatch({ type: 'LOGOUT_SUCCESS' });
          console.log('AuthContext: Logout successful (API call to /api/auth/logout succeeded).');
        } else {
          const errorMsg = `Logout API call to /api/auth/logout failed with status ${res.status}.`;
          dispatch({ type: 'LOGOUT_FAILURE', payload: { error: errorMsg } });
          console.warn(`AuthContext: ${errorMsg}`);
        }
      } catch (error: any) {
        const errorMsg = `Logout API call failed (network/other error): ${error.message || String(error)}`;
        dispatch({ type: 'LOGOUT_FAILURE', payload: { error: errorMsg } });
        console.error(`AuthContext: ${errorMsg}`);
      }
    } else {
      // No token, so local logout is sufficient
      dispatch({ type: 'LOGOUT_SUCCESS' });
      console.log('AuthContext: No active token to invalidate on backend during logout. Local logout complete.');
    }
  }, [state.token]);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
};

/**
 * Custom hook `useAuth` provides an easy way to access the authentication context values.
 * @returns The authentication context.
 * @throws Throws an error if used outside of an `AuthProvider`.
 */
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};