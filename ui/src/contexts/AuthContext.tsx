'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  token: string; // Added token field
}

interface AuthContextType {
  user: User | null;
  token: string | null; // Added token field
  isLoading: boolean;
  login: (userData: User) => void; // userData will now include token
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null); // Added token state
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const storedToken = localStorage.getItem('token');
    if (storedUser && storedToken) {
      setUser(JSON.parse(storedUser));
      setToken(storedToken);
    }
    setIsLoading(false);
  }, []);

  const login = (userData: User) => { // Expect userData to have a token property
    localStorage.setItem('user', JSON.stringify(userData));
    localStorage.setItem('token', userData.token); // Store token
    setUser(userData);
    setToken(userData.token); // Set token state
  };

  const logout = () => {
    localStorage.removeItem('user');
    localStorage.removeItem('token'); // Remove token
    setUser(null);
    setToken(null); // Clear token state
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout }}>
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