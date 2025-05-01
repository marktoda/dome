import NextAuth from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GithubProvider from 'next-auth/providers/github';
import { authClient } from '../../../../lib/authClient';

// Configure route to use Edge Runtime for Cloudflare Pages compatibility
export const runtime = 'edge';

// NextAuth.js handler
const handler = NextAuth({
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  
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
        session.user.id = token.userId as string;
        session.user.role = token.userRole as string;
        session.provider = token.provider as string;
        
        // Include the access token in the session
        session.token = token.accessToken as string;
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
          if (!credentials?.email || !credentials?.password) {
            throw new Error('Email and password required');
          }
          
          // Authenticate against the real auth service
          const result = await authClient.login(
            credentials.email, 
            credentials.password
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
});

export { handler as GET, handler as POST };