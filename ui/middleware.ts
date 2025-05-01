import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

// Protected routes that require authentication
const protectedPaths = ['/dashboard'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Check if the path is a protected route
  const isProtectedPath = protectedPaths.some(path =>
    pathname === path || pathname.startsWith(`${path}/`)
  );
  
  if (isProtectedPath) {
    // Get the user's session token from NextAuth
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET
    });
    
    // If there is no token, redirect to the login page
    if (!token) {
      const url = new URL('/auth/login', request.url);
      // Add the callbackUrl to redirect after login
      url.searchParams.set('callbackUrl', encodeURI(pathname));
      return NextResponse.redirect(url);
    }
    
    // Check if token has the required information
    if (!token.userId || !token.userRole) {
      const url = new URL('/auth/login', request.url);
      url.searchParams.set('error', 'Invalid session');
      return NextResponse.redirect(url);
    }
    
    // Here, we are relying on NextAuth's JWT validation
    // Our actual auth service validation is handled in the
    // NextAuth callbacks, so we don't need to re-validate
    // the token with authClient.validateToken here
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