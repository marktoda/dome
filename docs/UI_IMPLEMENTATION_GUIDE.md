# UI Implementation Guide

This guide provides practical implementation details for the Next.js UI application based on the architecture described in `UI_ARCHITECTURE.md`.

## Table of Contents

1. [Project Setup](#1-project-setup)
2. [Key Files Implementation](#2-key-files-implementation)
3. [Auth Integration](#3-auth-integration)
4. [Chat Integration](#4-chat-integration)
5. [Search Integration](#5-search-integration)
6. [Component Implementation](#6-component-implementation)
7. [Deployment](#7-deployment)

## 1. Project Setup

### Initialize a New Next.js Project

```bash
# Navigate to the services directory
cd services

# Create a new Next.js project with App Router
mkdir ui
cd ui
pnpm init
pnpm add next react react-dom typescript @types/react @types/node
```

### Create Base Directory Structure

```bash
mkdir -p app/{api/{auth,chat,search},(auth)/{login,register,oauth},chat,search,settings}
mkdir -p components/{auth,chat,common,layout,search}
mkdir -p lib/{api,hooks,state/{auth,chat,search},utils}
mkdir -p public styles
```

### Configure Next.js

Create `next.config.js`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: true,
    serverComponentsExternalPackages: ['@dome/common'],
  },
  images: {
    domains: ['github.com', 'api.notion.com'],
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/chat',
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
```

### Configure Package.json

Update `package.json`:

```json
{
  "name": "@dome/ui",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest"
  },
  "dependencies": {
    "@dome/common": "workspace:*",
    "@hookform/resolvers": "^3.3.2",
    "@radix-ui/react-avatar": "^1.0.4",
    "@radix-ui/react-dialog": "^1.0.5",
    "@radix-ui/react-dropdown-menu": "^2.0.6",
    "@radix-ui/react-slot": "^1.0.2",
    "@radix-ui/react-tabs": "^1.0.4",
    "@radix-ui/react-toast": "^1.1.5",
    "@tanstack/react-query": "^5.8.4",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.0.0",
    "framer-motion": "^10.16.5",
    "jose": "^5.1.1",
    "lucide-react": "^0.292.0",
    "next": "14.0.3",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-hook-form": "^7.48.2",
    "tailwind-merge": "^2.0.0",
    "tailwindcss-animate": "^1.0.7",
    "zod": "^3.22.4",
    "zustand": "^4.4.6"
  },
  "devDependencies": {
    "@types/node": "^20.9.3",
    "@types/react": "^18.2.38",
    "@types/react-dom": "^18.2.16",
    "autoprefixer": "^10.4.16",
    "eslint": "^8.54.0",
    "eslint-config-next": "14.0.3",
    "postcss": "^8.4.31",
    "tailwindcss": "^3.3.5",
    "typescript": "^5.3.2",
    "vitest": "^0.34.6"
  }
}
```

## 2. Key Files Implementation

### Root Layout

Create `app/layout.tsx`:

```tsx
import './globals.css';
import { Inter } from 'next/font/google';
import { Providers } from '@/components/providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata = {
  title: 'Dome Platform',
  description: 'AI-powered knowledge management and chat platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### Global Styles

Create `app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: 0 0% 100%;
  --foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --destructive: 0 100% 50%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 222.2 47.4% 11.2%;
}

.dark {
  --background: 224 71% 4%;
  --foreground: 213 31% 91%;
  --muted: 223 47% 11%;
  --muted-foreground: 215.4 16.3% 56.9%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 1.2%;
  --secondary: 222.2 47.4% 11.2%;
  --secondary-foreground: 210 40% 98%;
  --accent: 216 34% 17%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 63% 31%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 212.7 26.8% 83.9%;
}

@layer base {
  body {
    @apply bg-background text-foreground min-h-screen;
  }
}

@layer components {
  .chat-message-container {
    @apply grid gap-4 p-4;
  }

  .user-message {
    @apply bg-blue-100 dark:bg-blue-950 p-3 rounded-lg ml-auto max-w-[80%];
  }

  .assistant-message {
    @apply bg-gray-100 dark:bg-gray-800 p-3 rounded-lg mr-auto max-w-[80%];
  }
}
```

### Auth Middleware

Create `middleware.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { validateToken } from '@/lib/auth';

// Public paths that don't require authentication
const publicPaths = [
  '/login',
  '/register',
  '/oauth/github/callback',
  '/oauth/notion/callback',
];

export async function middleware(request: NextRequest) {
  const token = request.cookies.get('token')?.value;
  const path = request.nextUrl.pathname;

  // Check if the path is public
  if (publicPaths.some(publicPath => path.startsWith(publicPath))) {
    return NextResponse.next();
  }

  // Check if the path is for API routes that handle authentication
  if (path.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  // If no token exists, redirect to login
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    // Validate the token
    await validateToken(token);
    return NextResponse.next();
  } catch (error) {
    // Clear invalid token and redirect to login
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('token');
    return response;
  }
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * 1. /api routes that don't require authentication
     * 2. /_next (Next.js internals)
     * 3. /static (inside /public)
     * 4. /_vercel (Vercel internals)
     * 5. All files in /public (favicon.ico, etc.)
     */
    '/((?!_next|static|_vercel|favicon.ico|.*\\.(?:jpg|jpeg|png|gif|ico)).*)',
  ],
};
```

## 3. Auth Integration

### Auth API Client

Create `lib/api/auth.ts`:

```typescript
import { User } from '@/lib/types';

export class AuthClient {
  constructor(
    private baseUrl: string = process.env.NEXT_PUBLIC_AUTH_API_URL || '/api/auth'
  ) {}

  async register(
    email: string,
    password: string,
    name?: string
  ): Promise<{ user: User; token: string }> {
    const response = await fetch(`${this.baseUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, name }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to register');
    }

    return response.json();
  }

  async login(
    email: string,
    password: string
  ): Promise<{ user: User; token: string; expiresIn: number }> {
    const response = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to login');
    }

    return response.json();
  }

  async validate(token: string): Promise<User> {
    const response = await fetch(`${this.baseUrl}/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Invalid token');
    }

    const data = await response.json();
    return data.user;
  }

  async logout(token: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to logout');
    }
  }

  async initiateOAuth(provider: 'github' | 'notion'): Promise<string> {
    const response = await fetch(`${this.baseUrl}/oauth/${provider}/authorize`, {
      method: 'GET',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `Failed to initiate ${provider} OAuth`);
    }

    const data = await response.json();
    return data.authorizationUrl;
  }

  async handleOAuthCallback(
    provider: 'github' | 'notion',
    code: string
  ): Promise<{ user: User; token: string }> {
    const response = await fetch(`${this.baseUrl}/oauth/${provider}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `Failed to complete ${provider} OAuth`);
    }

    return response.json();
  }
}

// Create a singleton instance
export const authClient = new AuthClient();
```

### Auth API Route Handlers

Create `app/api/auth/login/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

// This would import from @dome/common in a real implementation
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: NextRequest) {
  try {
    // Parse and validate request body
    const body = await request.json();
    const { email, password } = loginSchema.parse(body);

    // Call Auth Service (using RPC or direct HTTP)
    const response = await fetch(`${process.env.AUTH_SERVICE_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      return NextResponse.json(
        { message: error.message || 'Authentication failed' },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Set auth token in HTTP-only cookie
    cookies().set({
      name: 'token',
      value: data.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: data.expiresIn,
      path: '/',
    });

    // Return response without the token (as it's in the cookie)
    return NextResponse.json({
      success: true,
      user: data.user,
    });
  } catch (error) {
    console.error('Login error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { message: 'Invalid input', errors: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

Create similar route handlers for register, logout, validate, and OAuth endpoints.

### Auth Store with Zustand

Create `lib/state/auth/store.ts`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '@/lib/types';
import { authClient } from '@/lib/api/auth';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  validateToken: () => Promise<boolean>;
  clearError: () => void;
  
  // OAuth actions
  connectOAuth: (provider: 'github' | 'notion') => Promise<string>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      
      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const { user } = await authClient.login(email, password);
          set({ user, isAuthenticated: true, isLoading: false });
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Login failed', 
            isLoading: false 
          });
          throw error;
        }
      },
      
      register: async (email, password, name) => {
        set({ isLoading: true, error: null });
        try {
          const { user } = await authClient.register(email, password, name);
          set({ user, isAuthenticated: true, isLoading: false });
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Registration failed', 
            isLoading: false 
          });
          throw error;
        }
      },
      
      logout: async () => {
        set({ isLoading: true, error: null });
        try {
          await authClient.logout(document.cookie.match(/token=([^;]+)/)?.[1] || '');
          set({ user: null, isAuthenticated: false, isLoading: false });
          
          // Clear cookie - would typically be handled by the API
          document.cookie = 'token=; Max-Age=0; path=/; domain=' + window.location.hostname;
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Logout failed', 
            isLoading: false 
          });
        }
      },
      
      validateToken: async () => {
        try {
          const token = document.cookie.match(/token=([^;]+)/)?.[1];
          if (!token) {
            set({ user: null, isAuthenticated: false });
            return false;
          }
          
          const user = await authClient.validate(token);
          set({ user, isAuthenticated: true });
          return true;
        } catch (error) {
          set({ user: null, isAuthenticated: false });
          return false;
        }
      },
      
      clearError: () => set({ error: null }),
      
      connectOAuth: async (provider) => {
        set({ isLoading: true, error: null });
        try {
          const authUrl = await authClient.initiateOAuth(provider);
          set({ isLoading: false });
          return authUrl;
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : `${provider} connection failed`, 
            isLoading: false 
          });
          throw error;
        }
      },
    }),
    {
      name: 'auth-storage',
      // Only persist the user information, not the state or functions
      partialize: (state) => ({ user: state.user }),
    }
  )
);
```

### Auth Hook

Create `lib/hooks/useAuth.ts`:

```typescript
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/state/auth/store';

export function useAuth() {
  const { 
    user, 
    isAuthenticated, 
    isLoading, 
    error,
    login, 
    register, 
    logout, 
    validateToken,
    clearError,
    connectOAuth
  } = useAuthStore();
  
  const router = useRouter();

  // Validate token on mount
  useEffect(() => {
    validateToken();
  }, [validateToken]);

  // Helper functions
  const loginAndRedirect = async (email: string, password: string, redirectTo = '/chat') => {
    try {
      await login(email, password);
      router.push(redirectTo);
    } catch (error) {
      // Error is handled by the store
    }
  };

  const registerAndRedirect = async (email: string, password: string, name?: string, redirectTo = '/chat') => {
    try {
      await register(email, password, name);
      router.push(redirectTo);
    } catch (error) {
      // Error is handled by the store
    }
  };

  const logoutAndRedirect = async (redirectTo = '/login') => {
    await logout();
    router.push(redirectTo);
  };

  const initiateOAuthFlow = async (provider: 'github' | 'notion') => {
    try {
      const authUrl = await connectOAuth(provider);
      // Redirect to the OAuth provider's authorization page
      window.location.href = authUrl;
    } catch (error) {
      // Error is handled by the store
    }
  };

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    login: loginAndRedirect,
    register: registerAndRedirect,
    logout: logoutAndRedirect,
    clearError,
    initiateOAuthFlow,
  };
}
```

### Login Page

Create `app/(auth)/login/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useAuth } from '@/lib/hooks/useAuth';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { GithubIcon } from 'lucide-react';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const { login, error, clearError, initiateOAuthFlow } = useAuth();
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginForm) => {
    setIsLoading(true);
    try {
      await login(data.email, data.password);
    } catch (error) {
      // Error is handled by the auth hook/store
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthLogin = async (provider: 'github' | 'notion') => {
    setIsLoading(true);
    try {
      await initiateOAuthFlow(provider);
    } catch (error) {
      // Error is handled by the auth hook/store
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center">
          <h1 className="text-3xl font-bold">Welcome back</h1>
          <p className="text-sm text-gray-500 mt-2">
            Sign in to your account to continue
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mt-6">
            {error}
            <button
              onClick={clearError}
              className="float-right text-red-700 hover:text-red-900"
            >
              ×
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-6">
          <div className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                {...register('email')}
                className={errors.email ? 'border-red-300' : ''}
              />
              {errors.email && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="block text-sm font-medium">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-sm font-medium text-blue-600 hover:text-blue-500"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password')}
                className={errors.password ? 'border-red-300' : ''}
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.password.message}
                </p>
              )}
            </div>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Signing in...' : 'Sign in'}
          </Button>

          <div className="relative mt-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-gray-500">
                Or continue with
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOAuthLogin('github')}
              disabled={isLoading}
            >
              <GithubIcon className="h-4 w-4 mr-2" />
              GitHub
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOAuthLogin('notion')}
              disabled={isLoading}
            >
              <svg className="h-4 w-4 mr-2" viewBox="0 0 99 124" fill="currentColor">
                <path d="M24.73 70.42v-40.26c0-6.07-1.5-7.77-6.07-8.13v-2.91h23.03c11.64 0 18.61 2.7 18.61 13.45 0 6.49-3.96 11.85-10.45 13.87v.42c8.34 1.5 13.66 6.7 13.66 15.36 0 11.85-8.76 17.42-22.25 17.42h-22.62v-2.91c6.28-.42 6.07-4.16 6.07-6.32h.02zm15.14 1.7c5.86 0 8.55-3.12 8.55-9.4V52.55c0-5.65-2.7-7.98-7.9-7.98h-2.28v17.84h-1.7c-1.7 0-2.28 1.5-2.28 3.12v1.07c0 4.79 1.28 5.52 5.61 5.52zm-2.07-32.99h2.49c4.58 0 6.49-3.12 6.49-7.48v-6.07c0-4.79-1.5-7.48-6.28-7.48h-2.7v21.03zM73.04 11.12v2.91c-4.58.42-6.07 1.93-6.07 8.13v38.76c0 4.37.85 7.69 4.79 7.69 3.12 0 6.28-3.96 7.98-7.48l2.07 1.28c-3.12 8.55-9.61 16.12-19.89 16.12-9.19 0-13.87-5.23-13.87-15.78v-40.7c0-6.07-1.28-7.77-5.86-8.13v-2.91h30.85v.11z"/>
              </svg>
              Notion
            </Button>
          </div>
        </form>

        <p className="mt-8 text-center text-sm text-gray-500">
          Don't have an account?{' '}
          <Link
            href="/register"
            className="font-medium text-blue-600 hover:text-blue-500"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
```

## 4. Chat Integration

### Chat API Client

Create `lib/api/chat.ts`:

```typescript
import { Message, ChatSession, ChatRequest, ChatResponse } from '@/lib/types';

export class ChatClient {
  constructor(
    private baseUrl: string = process.env.NEXT_PUBLIC_CHAT_API_URL || '/api/chat'
  ) {}

  async sendMessage(
    userId: string,
    chatId: string,
    content: string,
    options?: {
      enhanceWithContext?: boolean;
      maxContextItems?: number;
      includeSourceInfo?: boolean;
      maxTokens?: number;
      temperature?: number;
      modelId?: string;
    }
  ): Promise<ChatResponse> {
    const messages: Message[] = [
      {
        role: 'user',
        content,
        timestamp: Date.now(),
      },
    ];
    
    const request: ChatRequest = {
      userId,
      messages,
      options: {
        enhanceWithContext: options?.enhanceWithContext ?? true,
        maxContextItems: options?.maxContextItems ?? 10,
        includeSourceInfo: options?.includeSourceInfo ?? true,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        modelId: options?.modelId,
      },
      stream: false,
    };

    const response = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to send message');
    }

    return response.json();
  }

  async streamMessage(
    userId: string,
    chatId: string,
    content: string,
    options?: {
      enhanceWithContext?: boolean;
      maxContextItems?: number;
      includeSourceInfo?: boolean;
      maxTokens?: number;
      temperature?: number;
      modelId?: string;
    },
    onChunk?: (chunk: string) => void
  ): Promise<ReadableStream> {
    const messages: Message[] = [
      {
        role: 'user',
        content,
        timestamp: Date.now(),
      },
    ];
    
    const request: ChatRequest = {
      userId,
      messages,
      options: {
        enhanceWithContext: options?.enhanceWithContext ?? true,
        maxContextItems: options?.maxContextItems ?? 10,
        includeSourceInfo: options?.includeSourceInfo ?? true,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        modelId: options?.modelId,
      },
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to stream message');
    }

    // If a chunk handler is provided, process the stream
    if (onChunk && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      // Process the stream
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            // Skip the "data: " prefix and parse the JSON
            const lines = chunk.split('\n\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6);
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.response) {
                    onChunk(parsed.response);
                  }
                } catch (e) {
                  console.error('Error parsing SSE chunk:', e);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error reading stream:', error);
        }
      })();
    }

    return response.body as ReadableStream;
  }

  async getChatHistory(userId: string): Promise<ChatSession[]> {
    const response = await fetch(`${this.baseUrl}/history?userId=${userId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get chat history');
    }

    return response.json();
  }

  async getChatSession(chatId: string): Promise<ChatSession> {
    const response = await fetch(`${this.baseUrl}/session/${chatId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get chat session');
    }

    return response.json();
  }

  async createChatSession(userId: string, title?: string): Promise<ChatSession> {
    const response = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, title: title || 'New Chat' }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to create chat session');
    }

    return response.json();
  }

  async deleteChatSession(chatId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session/${chatId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to delete chat session');
    }
  }
}

// Create a singleton instance
export const chatClient = new ChatClient();
```

### Chat State with Zustand

Create `lib/state/chat/store.ts`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ChatSession, Message, Source } from '@/lib/types';
import { chatClient } from '@/lib/api/chat';

interface ChatState {
  activeChatId: string | null;
  chats: Record<string, ChatSession>;
  messages: Record<string, Message[]>;
  sources: Record<string, Source[]>;
  isLoading: boolean;
  error: string | null;
  streamingMessageId: string | null;
  
  // Actions
  setActiveChatId: (chatId: string) => void;
  sendMessage: (content: string, options?: any) => Promise<void>;
  streamMessage: (content: string, options?: any) => Promise<void>;
  createChat: (userId: string, title?: string) => Promise<string>;
  deleteChat: (chatId: string) => Promise<void>;
  loadChatHistory: (userId: string) => Promise<void>;
  loadChatSession: (chatId: string) => Promise<void>;
  appendStreamChunk: (chatId: string, messageId: string, chunk: string) => void;
  clearError: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      activeChatId: null,
      chats: {},
      messages: {},
      sources: {},
      isLoading: false,
      error: null,
      streamingMessageId: null,
      
      setActiveChatId: (chatId) => set({ activeChatId: chatId }),
      
      sendMessage: async (content, options) => {
        const { activeChatId } = get();
        if (!activeChatId) {
          set({ error: 'No active chat session' });
          return;
        }
        
        set({ isLoading: true, error: null });
        try {
          // Add user message to UI immediately
          const userMessageId = `user-${Date.now()}`;
          const userMessage: Message = {
            id: userMessageId,
            role: 'user',
            content,
            timestamp: Date.now(),
          };
          
          set((state) => ({
            messages: {
              ...state.messages,
              [activeChatId]: [
                ...(state.messages[activeChatId] || []),
                userMessage,
              ],
            },
          }));
          
          // Extract userId from the chat session
          const chatSession = get().chats[activeChatId];
          if (!chatSession) {
            throw new Error('Chat session not found');
          }
          
          // Send message to API
          const response = await chatClient.sendMessage(
            chatSession.userId,
            activeChatId,
            content,
            options
          );
          
          // Add assistant response to UI
          const assistantMessageId = `assistant-${Date.now()}`;
          const assistantMessage: Message = {
            id: assistantMessageId,
            role: 'assistant',
            content: response.response,
            timestamp: Date.now(),
          };
          
          set((state) => ({
            messages: {
              ...state.messages,
              [activeChatId]: [
                ...(state.messages[activeChatId] || []),
                assistantMessage,
              ],
            },
            sources: {
              ...state.sources,
              [assistantMessageId]: response.sources || [],
            },
            isLoading: false,
          }));
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Failed to send message', 
            isLoading: false 
          });
        }
      },
      
      streamMessage: async (content, options) => {
        const { activeChatId } = get();
        if (!activeChatId) {
          set({ error: 'No active chat session' });
          return;
        }
        
        set({ isLoading: true, error: null });
        try {
          // Add user message to UI immediately
          const userMessageId = `user-${Date.now()}`;
          const userMessage: Message = {
            id: userMessageId,
            role: 'user',
            content,
            timestamp: Date.now(),
          };
          
          // Create empty assistant message for streaming
          const assistantMessageId = `assistant-${Date.now()}`;
          const assistantMessage: Message = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
          };
          
          set((state) => ({
            messages: {
              ...state.messages,
              [activeChatId]: [
                ...(state.messages[activeChatId] || []),
                userMessage,
                assistantMessage,
              ],
            },
            streamingMessageId: assistantMessageId,
          }));
          
          // Extract userId from the chat session
          const chatSession = get().chats[activeChatId];
          if (!chatSession) {
            throw new Error('Chat session not found');
          }
          
          // Stream message from API
          await chatClient.streamMessage(
            chatSession.userId,
            activeChatId,
            content,
            options,
            (chunk) => {
              // Append each chunk to the streaming message
              get().appendStreamChunk(activeChatId, assistantMessageId, chunk);
            }
          );
          
          set({ isLoading: false, streamingMessageId: null });
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Failed to stream message', 
            isLoading: false,
            streamingMessageId: null,
          });
        }
      },
      
      createChat: async (userId, title) => {
        set({ isLoading: true, error: null });
        try {
          const newChat = await chatClient.createChatSession(userId, title);
          set((state) => ({
            chats: {
              ...state.chats,
              [newChat.id]: newChat,
            },
            activeChatId: newChat.id,
            isLoading: false,
          }));
          return newChat.id;
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Failed to create chat', 
            isLoading: false 
          });
          throw error;
        }
      },
      
      deleteChat: async (chatId) => {
        set({ isLoading: true, error: null });
        try {
          await chatClient.deleteChatSession(chatId);
          
          set((state) => {
            // Create new objects without the deleted chat
            const { [chatId]: _, ...remainingChats } = state.chats;
            const { [chatId]: __, ...remainingMessages } = state.messages;
            
            // If the deleted chat was active, set the first remaining chat as active
            let newActiveChatId = state.activeChatId;
            if (newActiveChatId === chatId) {
              const chatIds = Object.keys(remainingChats);
              newActiveChatId = chatIds.length > 0 ? chatIds[0] : null;
            }
            
            return {
              chats: remainingChats,
              messages: remainingMessages,
              activeChatId: newActiveChatId,
              isLoading: false,
            };
          });
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Failed to delete chat', 
            isLoading: false 
          });
        }
      },
      
      loadChatHistory: async (userId) => {
        set({ isLoading: true, error: null });
        try {
          const chatHistory = await chatClient.getChatHistory(userId);
          
          // Convert array to record
          const chatsRecord: Record<string, ChatSession> = {};
          for (const chat of chatHistory) {
            chatsRecord[chat.id] = chat;
          }
          
          set({
            chats: chatsRecord,
            isLoading: false,
            // Set the first chat as active if none is active
            activeChatId: get().activeChatId || (chatHistory.length > 0 ? chatHistory[0].id : null),
          });
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Failed to load chat history', 
            isLoading: false 
          });
        }
      },
      
      loadChatSession: async (chatId) => {
        set({ isLoading: true, error: null });
        try {
          const chatSession = await chatClient.getChatSession(chatId);
          
          set((state) => ({
            chats: {
              ...state.chats,
              [chatId]: chatSession,
            },
            messages: {
              ...state.messages,
              [chatId]: chatSession.messages || [],
            },
            isLoading: false,
          }));
        } catch (error) {
          set({ 
            error: error instanceof Error ? error.message : 'Failed to load chat session', 
            isLoading: false 
          });
        }
      },
      
      appendStreamChunk: (chatId, messageId, chunk) => {
        set((state) => {
          const chatMessages = state.messages[chatId] || [];
          const messageIndex = chatMessages.findIndex(msg => msg.id === messageId);
          
          if (messageIndex === -1) return state;
          
          // Create a new array with the updated message
          const updatedMessages = [...chatMessages];
          updatedMessages[messageIndex] = {
            ...updatedMessages[messageIndex],
            content: updatedMessages[messageIndex].content + chunk,
          };
          
          return {
            messages: {
              ...state.messages,
              [chatId]: updatedMessages,
            },
          };
        });
      },
      
      clearError: () => set({ error: null }),
    }),
    {
      name: 'chat-storage',
      // Only persist chats and messages, not the entire state
      partialize: (state) => ({ 
        chats: state.chats,
        messages: state.messages,
        sources: state.sources,
        activeChatId: state.activeChatId,
      }),
    }
  )
);
```

### Chat API Route Handler

Create `app/api/chat/send/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { cookies } from 'next/headers';

// This would import from @dome/common in a real implementation
const chatRequestSchema = z.object({
  userId: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      timestamp: z.number().optional(),
    })
  ),
  options: z.object({
    enhanceWithContext: z.boolean().optional().default(true),
    maxContextItems: z.number().optional().default(10),
    includeSourceInfo: z.boolean().optional().default(true),
    maxTokens: z.number().optional(),
    temperature: z.number().optional(),
    modelId: z.string().optional(),
  }).optional(),
  stream: z.boolean().optional().default(false),
  runId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Get auth token from cookies
    const token = cookies().get('token')?.value;
    if (!token) {
      return NextResponse.json(
        { message: 'Authentication required' },
        { status: 401 }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const chatRequest = chatRequestSchema.parse(body);

    // Call Chat Service using RPC or direct HTTP
    const response = await fetch(`${process.env.CHAT_SERVICE_URL}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(chatRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      return NextResponse.json(
        { message: error.message || 'Chat service error' },
        { status: response.status }
      );
    }

    // Return the chat service response
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Chat API error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { message: 'Invalid input', errors: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

Create similar handlers for stream, history, and session endpoints.

## 5. Search Integration

### Search API Client

Create `lib/api/search.ts`:

```typescript
import { SearchResult, SearchFilters } from '@/lib/types';

export class SearchClient {
  constructor(
    private baseUrl: string = process.env.NEXT_PUBLIC_SEARCH_API_URL || '/api/search'
  ) {}

  async search(
    userId: string,
    query: string,
    filters?: SearchFilters,
    page = 1,
    limit = 10
  ): Promise<{ results: SearchResult[]; total: number; page: number; limit: number }> {
    const queryParams = new URLSearchParams({
      userId,
      query,
      page: page.toString(),
      limit: limit.toString(),
    });

    // Add filters to query params if they exist
    if (filters) {
      if (filters.source) queryParams.append('source', filters.source);
      if (filters.type) queryParams.append('type', filters.type);
      if (filters.dateFrom) queryParams.append('dateFrom', filters.dateFrom);
      if (filters.dateTo) queryParams.append('dateTo', filters.dateTo);
    }

    const response = await fetch(`${this.baseUrl}?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Search failed');
    }

    return response.json();
  }

  async getSuggestions(
    userId: string,
    query: string,
    limit = 5
  ): Promise<string[]> {
    const response = await fetch(
      `${this.baseUrl}/suggestions?userId=${userId}&query=${encodeURIComponent(query)}&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get suggestions');
    }

    return response.json();
  }

  async getSearchHistory(
    userId: string,
    limit = 10
  ): Promise<string[]> {
    const response = await fetch(
      `${this.baseUrl}/history?userId=${userId}&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get search history');
    }

    return response.json();
  }

  async getAvailableSources(userId: string): Promise<string[]> {
    const response = await fetch(
      `${this.baseUrl}/sources?userId=${userId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get available sources');
    }

    return response.json();
  }

  async getAvailableTypes(userId: string): Promise<string[]> {
    const response = await fetch(
      `${this.baseUrl}/types?userId=${userId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get available types');
    }

    return response.json();
  }
}

// Create a singleton instance
export const searchClient = new SearchClient();
```

## 6. Component Implementation

### Chat Interface Component

Create `components/chat/ChatInterface.tsx`:

```tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/lib/hooks/useAuth';
import { useChatStore } from '@/lib/state/chat/store';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Send, RefreshCw } from 'lucide-react';

export function ChatInterface() {
  const { user } = useAuth();
  const { 
    activeChatId, 
    messages, 
    isLoading, 
    error,
    streamMessage,
    clearError
  } = useChatStore();
  
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Get messages for active chat
  const activeMessages = activeChatId ? messages[activeChatId] || [] : [];
  
  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeMessages]);
  
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !user || !activeChatId) return;
    
    try {
      await streamMessage(inputValue);
      setInputValue('');
    } catch (error) {
      // Error is handled by the chat store
      console.error('Failed to send message:', error);
    }
  };
  
  if (!activeChatId) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-lg text-gray-400">Select a chat or create a new one</p>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="py-4 px-6 border-b">
        <h2 className="text-lg font-semibold">
          {activeChatId ? 'Chat Session' : 'New Chat'}
        </h2>
      </div>
      
      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 m-4 rounded-md">
          {error}
          <button
            onClick={clearError}
            className="float-right text-red-700 hover:text-red-900"
          >
            ×
          </button>
        </div>
      )}
      
      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          {activeMessages.map((message) => (
            <div
              key={message.id || `${message.role}-${message.timestamp}`}
              className={`p-4 rounded-lg max-w-[80%] ${
                message.role === 'user'
                  ? 'bg-blue-100 dark:bg-blue-950 ml-auto'
                  : message.role === 'assistant'
                  ? 'bg-gray-100 dark:bg-gray-800'
                  : 'bg-yellow-100 dark:bg-yellow-900 w-full'
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
            </div>
          ))}
          {isLoading && !activeMessages.some((m) => m.content === '') && (
            <div className="flex items-center p-4 rounded-lg bg-gray-100 dark:bg-gray-800 max-w-[80%]">
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              Thinking...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
      
      {/* Chat input */}
      <div className="border-t p-4">
        <form onSubmit={handleSendMessage} className="flex items-center space-x-2">
          <Input
            type="text"
            placeholder="Type your message..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isLoading}
            className="flex-1"
          />
          <Button type="submit" disabled={isLoading || !inputValue.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
```

## 7. Deployment

### Build and Deployment Process

1. Configure build settings in package.json:

```json
"scripts": {
  "build": "next build",
  "start": "next start"
}
```

2. Set up environment variables for production:

Create a `.env.production` file:

```
NEXT_PUBLIC_AUTH_API_URL=https://auth.dome-api.com
NEXT_PUBLIC_CHAT_API_URL=https://chat.dome-api.com
NEXT_PUBLIC_SEARCH_API_URL=https://search.dome-api.com
AUTH_SERVICE_URL=https://auth.dome-api.com
CHAT_SERVICE_URL=https://chat.dome-api.com
SEARCH_SERVICE_URL=https://search.dome-api.com
```

3. Build the application:

```bash
pnpm build
```

4. Deploy using Cloudflare Pages or similar service.

### Cloudflare Pages Configuration

Create a `wrangler.toml` file for Cloudflare Pages deployment:

```toml
name = "dome-ui"
main = "./.next/server/app/index.js"
compatibility_date = "2025-04-15"
compatibility_flags = []
workers_dev = false

[site]
bucket = "./.next/static"

[build]
command = "pnpm build"
upload.format = "service-worker"

[[services]]
binding = "AUTH"
service = "auth"

[[services]]
binding = "CHAT"
service = "chat-service"

[[services]]
binding = "SEARCH"
service = "silo"

[vars]
NODE_ENV = "production"