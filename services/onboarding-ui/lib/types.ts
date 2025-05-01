import 'next-auth';

// Extend the built-in session types
declare module 'next-auth' {
  interface Session {
    provider?: string;
    user?: {
      id?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    }
  }
}