import 'next-auth';
// We use UserRole types from authTypes in the extended session
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { UserRole } from './authTypes';

// Extend the built-in next-auth types
declare module 'next-auth' {
  interface Session {
    provider?: string;
    token?: string;
    user?: {
      id?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role?: string;
    }
  }

  interface User {
    id: string;
    name?: string;
    email: string;
    image?: string | null;
    role?: string;
    token?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
    userRole?: string;
    provider?: string;
    accessToken?: string;
  }
}