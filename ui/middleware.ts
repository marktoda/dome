import { NextRequest, NextResponse } from 'next/server';
import { auth } from './auth';

// Configure explicitly for edge runtime for Cloudflare Pages compatibility
export const runtime = 'experimental-edge';

// Protected routes that require authentication
const protectedPaths = ['/dashboard'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if the path is a protected route
  const isProtectedPath = protectedPaths.some(
    path => pathname === path || pathname.startsWith(`${path}/`),
  );

  if (isProtectedPath) {
    try {
      // Get the user's session using Auth.js v5
      const session = await auth();

      // If there is no session, redirect to the login page
      if (!session) {
        const url = new URL('/auth/login', request.url);
        // Add the callbackUrl to redirect after login
        url.searchParams.set('callbackUrl', encodeURI(pathname));
        return NextResponse.redirect(url);
      }

      // Check if session has the required information
      if (!session.user?.id) {
        const url = new URL('/auth/login', request.url);
        url.searchParams.set('error', 'Invalid session');
        return NextResponse.redirect(url);
      }
    } catch (error) {
      console.error('Auth middleware error:', error);
      // Handle auth errors gracefully
      const url = new URL('/auth/error', request.url);
      return NextResponse.redirect(url);
    }
  }

  // Allow the request to continue
  return NextResponse.next();
}

// Specify which paths the middleware should run on
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * 1. /api routes
     * 2. /_next (Next.js internals)
     * 3. /fonts, /icons, /images (static files)
     * 4. /favicon.ico, /sitemap.xml (SEO files)
     */
    '/((?!api|_next|fonts|icons|images|favicon.ico|sitemap.xml).*)',
  ],
};
