import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { authClient } from "./lib/authClient";
import type { DefaultSession, NextAuthConfig } from "next-auth";

// Set the runtime to support Edge environments like Cloudflare Pages
export const runtime = "experimental-edge";

// Extend the built-in session types
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id?: string;
      role?: string;
    } & DefaultSession["user"];
    provider?: string;
    token?: string;
  }
  interface User {
    id: string;
    role?: string;
    token?: string;
  }
}

// Configure NextAuth
const authConfig: NextAuthConfig = {
  // For development, trust all hosts
  trustHost: true,
  // Add a secret for signing tokens
  secret: process.env.NEXTAUTH_SECRET || "development-secret-key-change-me-in-production",
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID || "dummy-github-client-id",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "dummy-github-client-secret",
    }),
    Credentials({
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) {
            throw new Error("Email and password required");
          }
          
          // Authenticate against the real auth service
          const result = await authClient.login(
            credentials.email as string,
            credentials.password as string
          );
          
          if (result.success) {
            // Return the user with token for JWT session
            return {
              id: result.user.id,
              name: result.user.name || result.user.email.split('@')[0],
              email: result.user.email,
              role: result.user.role,
              token: result.token,
              image: null,
            };
          }
          
          return null;
        } catch (error) {
          console.error("Auth error:", error);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      // Initial sign in
      if (account && user) {
        // Store provider info and token
        return {
          ...token,
          provider: account.provider,
          accessToken: account.provider === 'credentials' ? user.token : token.accessToken,
          userId: user.id,
          userRole: user.role,
        };
      }
      
      // Return previous token on subsequent calls
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        // Add custom claims to the session
        if (token.userId) {
          session.user.id = token.userId as string;
        }
        if (token.userRole) {
          session.user.role = token.userRole as string;
        }
        if (token.provider) {
          session.provider = token.provider as string;
        }
        
        // Include the access token in the session
        if (token.accessToken) {
          session.token = token.accessToken as string;
        }
      }
      
      return session;
    },
  },
  pages: {
    signIn: '/auth/login',
    signOut: '/',
    error: '/auth/error',
  },
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
};

// Create and export the auth handlers
export const { auth, handlers, signIn, signOut } = NextAuth(authConfig);
