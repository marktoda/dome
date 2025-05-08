'use client';

import { ReactNode, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Navbar } from './Navbar';

/**
 * Props for the {@link MainLayout} component.
 */
interface MainLayoutProps {
  /** The content to be rendered within the layout. */
  children: ReactNode;
}

/**
 * Routes that are considered authentication-related (e.g., login, registration).
 * Users accessing these routes while already authenticated may be redirected.
 */
const AUTH_ROUTES = ['/login', '/register'];

/**
 * Routes that require user authentication.
 * Unauthenticated users attempting to access these routes will be redirected to the login page.
 */
const PROTECTED_ROUTES = ['/chat', '/search', '/settings']; // Add other protected routes here

/**
 * `MainLayout` is a top-level layout component that handles authentication-based routing
 * and conditionally renders a navigation bar.
 *
 * It performs the following actions:
 * - If the user is authenticated and tries to access an authentication route (e.g., login),
 *   it redirects them to the home page (`/`).
 * - If the user is not authenticated and tries to access a protected route,
 *   it redirects them to the login page (`/login`).
 * - Displays a loading state while authentication status is being determined.
 * - Renders a {@link Navbar} for non-authentication pages.
 *
 * Note: This layout might be used in conjunction with other layouts like `LayoutWithSidebar`
 * which handles the display of a header and sidebar for specific application sections.
 * Care should be taken to avoid redundant UI elements (e.g., multiple top bars) if nested.
 *
 * @param props - The props for the component.
 * @param props.children - The child elements to render within the layout.
 * @returns A React functional component representing the main application layout.
 */
export function MainLayout({ children }: MainLayoutProps) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading) {
      const isAuthRouteCurrentPage = AUTH_ROUTES.includes(pathname);
      const isProtectedRouteCurrentPage = PROTECTED_ROUTES.some(route => pathname.startsWith(route));

      if (user && isAuthRouteCurrentPage) {
        router.push('/'); // Redirect to home if logged in and on an auth page
      } else if (!user && isProtectedRouteCurrentPage) {
        router.push('/login'); // Redirect to login if not logged in and on a protected page
      }
    }
  }, [user, isLoading, router, pathname]);

  if (isLoading) {
    // TODO: Replace with a more sophisticated loading component (e.g., full-page spinner or skeleton).
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  const isCurrentlyOnAuthPage = AUTH_ROUTES.includes(pathname);

  return (
    <div className="flex min-h-screen w-full flex-col">
      {!isCurrentlyOnAuthPage && <Navbar />}
      <main className={`flex flex-1 flex-col ${!isCurrentlyOnAuthPage ? 'pt-0' : ''}`}>
        {/* The pt-0 class when Navbar is shown implies Navbar is part of the flex flow
            or main content should not have top padding. If Navbar is fixed/absolute,
            main content might need padding-top to avoid being obscured.
        */}
        {children}
      </main>
    </div>
  );
}