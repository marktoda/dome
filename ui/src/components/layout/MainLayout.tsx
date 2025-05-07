'use client';

import { ReactNode, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Navbar } from './Navbar';

interface MainLayoutProps {
  children: ReactNode;
}

const AUTH_ROUTES = ['/login', '/register'];
const PROTECTED_ROUTES = ['/chat', '/search', '/settings']; // Add other protected routes here

export function MainLayout({ children }: MainLayoutProps) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading) {
      const isAuthRoute = AUTH_ROUTES.includes(pathname);
      const isProtectedRoute = PROTECTED_ROUTES.some(route => pathname.startsWith(route));

      if (user && isAuthRoute) {
        router.push('/'); // Redirect to home if logged in and on auth page
      } else if (!user && isProtectedRoute) {
        router.push('/login'); // Redirect to login if not logged in and on protected page
      }
    }
  }, [user, isLoading, router, pathname]);

  if (isLoading) {
    // You can replace this with a proper loading spinner/component
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  const isAuthPage = AUTH_ROUTES.includes(pathname);

  return (
    <div className="flex min-h-screen w-full flex-col">
      {!isAuthPage && <Navbar />}
      <main className={`flex flex-1 flex-col ${!isAuthPage ? 'pt-0' : ''}`}>
        {children}
      </main>
    </div>
  );
}