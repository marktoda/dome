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
        // TODO: Create and call /api/auth/me
        const response = await fetch('/api/auth/me'); // Conceptual endpoint
        if (response.ok) {
          const userData = await response.json();
          setUser(userData.user);
        } else {
          setUser(null);
        }
      } catch (error) {
        console.error('Failed to fetch user:', error);
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