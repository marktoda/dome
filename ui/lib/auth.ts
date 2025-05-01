import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GithubProvider from 'next-auth/providers/github';
import { z } from 'zod';

// This would connect to your actual authentication API
async function authenticateUser(email: string, password: string) {
  // This is a mock implementation, replace with actual auth logic
  if (email === 'demo@example.com' && password === 'password') {
    return {
      id: '1',
      name: 'Demo User',
      email: 'demo@example.com',
    };
  }
  
  // For demo purposes, allow any credentials
  if (email && password.length >= 6) {
    return {
      id: Math.floor(Math.random() * 1000).toString(),
      name: email.split('@')[0],
      email: email,
    };
  }
  
  return null;
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  
  callbacks: {
    async jwt({ token, user, account }) {
      // Add provider to token
      if (account) {
        token.provider = account.provider;
      }
      // Add user ID to token
      if (user) {
        token.userId = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session) {
        // Add provider to session
        session.provider = token.provider as string;
        
        // Add user ID to session
        if (session.user) {
          session.user.id = token.userId as string;
        }
      }
      return session;
    },
  },
  
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID || 'dummy-github-client-id',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || 'dummy-github-client-secret',
    }),
    {
      id: 'notion',
      name: 'Notion',
      type: 'oauth',
      authorization: {
        url: 'https://api.notion.com/v1/oauth/authorize',
        params: { scope: 'read_user' }
      },
      token: 'https://api.notion.com/v1/oauth/token',
      userinfo: 'https://api.notion.com/v1/users/me',
      profile(profile) {
        return {
          id: profile.id || '12345',
          name: profile.name || 'Notion User',
          email: profile.email || 'user@example.com',
          image: profile.image || ''
        };
      },
      clientId: process.env.NOTION_CLIENT_ID || 'dummy-notion-client-id',
      clientSecret: process.env.NOTION_CLIENT_SECRET || 'dummy-notion-client-secret',
      client: {
        token_endpoint_auth_method: 'client_secret_basic'
      }
    },
    CredentialsProvider({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        try {
          if (!credentials) return null;
          
          // Validate credentials
          const schema = z.object({
            email: z.string().email(),
            password: z.string().min(6),
          });
          
          const result = schema.safeParse(credentials);
          if (!result.success) return null;
          
          const { email, password } = result.data;
          
          // Authenticate user
          const user = await authenticateUser(email, password);
          return user;
        } catch (error) {
          console.error('Auth error:', error);
          return null;
        }
      },
    }),
  ],
  
  pages: {
    signIn: '/auth/login',
    signOut: '/',
    error: '/auth/error',
  },
};