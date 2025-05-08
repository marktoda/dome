'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface User { // Token is removed as it's now in an HttpOnly cookie
  id: string;
  name: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  // token: string | null; // Token state removed
  isLoading: boolean;
  login: (userData: User) => void; // userData might not include token directly anymore
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  // const [token, setToken] = useState<string | null>(null); // Token state removed
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if user is authenticated by calling a /api/auth/me endpoint
    // This endpoint would verify the HttpOnly cookie and return user data
    const fetchUser = async () => {
      try {
        // Call /api/auth/validate to check session and get user data
        // This endpoint is POST as per user-provided backend routes
        const response = await fetch('/api/auth/validate', { method: 'POST' });
        if (response.ok) {
          const validationData = await response.json();
          // Assuming the validation endpoint returns user data in a 'user' field if valid
          // or a structure like { valid: true, user: { ... } }
          // Adjust based on actual response structure of /api/auth/validate
          if (validationData && validationData.user) {
            setUser(validationData.user);
          } else if (validationData && validationData.valid === true && validationData.data && validationData.data.user) { // Another common pattern
            setUser(validationData.data.user);
          }
          // If the response is ok but doesn't contain user data directly,
          // it might just be a validation confirmation.
          // For now, we assume it returns user data if session is valid.
          // If not, and it only returns {valid: true}, then setUser(null) might be incorrect here
          // unless an invalid session explicitly returns !response.ok
          else if (validationData && validationData.valid === false) {
             setUser(null);
          }
          // If response.ok but no user data, and not explicitly invalid, what to do?
          // For now, if ok and no user, assume not logged in or endpoint doesn't return user.
          // Best if /api/auth/validate returns user object on successful validation.
          else {
            // If response is ok but no user data and not explicitly invalid,
            // it might mean the session is valid but no user data is returned by this specific endpoint.
            // This case needs clarification on /api/auth/validate's response.
            // For safety, if user data isn't clearly provided upon successful validation, assume not logged in for client state.
            console.warn('/api/auth/validate responded OK but did not provide user data as expected.');
            setUser(null);
          }
        } else {
          // If response is not ok (e.g., 401 Unauthorized, 403 Forbidden), session is invalid or user not logged in.
          setUser(null);
        }
      } catch (error) {
        console.error('Failed to validate session / fetch user:', error);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchUser();
  }, []);

  const login = (userData: User) => {
    // The /api/auth/login route now sets the HttpOnly cookie.
    // This function just updates the client-side user state.
    // localStorage.setItem('user', JSON.stringify(userData)); // Optionally still store user for quick UI, but /api/auth/me is source of truth
    setUser(userData);
    // setToken(userData.token); // Token is not handled here anymore
  };

  const logout = async () => {
    // localStorage.removeItem('user'); // Clear any local user snapshot
    // localStorage.removeItem('token'); // Token is not in localStorage anymore
    setUser(null);
    // setToken(null); // Token state removed
    try {
      // TODO: Create and call /api/auth/logout to clear the HttpOnly cookie
      await fetch('/api/auth/logout', { method: 'POST' }); // Conceptual endpoint
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, /*token,*/ isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};