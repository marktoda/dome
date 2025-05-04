import { DefaultSession } from 'next-auth';

// We use UserRole types from authTypes in the extended session
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { UserRole } from './authTypes';

// Extend the built-in Auth.js types
declare module 'next-auth' {
  interface Session {
    provider?: string;
    token?: string;
    user: {
      id?: string;
      role?: string;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    name?: string;
    email: string;
    image?: string | null;
    role?: string;
    token?: string;
  }

  // JWT type is now in the same module in Auth.js v5
  interface JWT {
    userId?: string;
    userRole?: string;
    provider?: string;
    accessToken?: string;
  }
}
