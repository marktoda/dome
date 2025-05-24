'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Header } from '@/components/layout/Header';

/**
 * Props for the {@link LayoutWithSidebar} component.
 */
interface LayoutWithSidebarProps {
  /** The content to be rendered within the layout. */
  children: React.ReactNode;
}

/**
 * Defines the routes that should not display the main application layout (header and sidebar).
 * These typically include authentication pages (login, register) and the landing page.
 */
const AUTH_ROUTES = ['/login', '/register', '/forgot-password'];

/**
 * `LayoutWithSidebar` provides the main application structure, including a header and a sidebar.
 * It conditionally renders this structure based on the current route.
 * For authentication routes or the landing page, it renders children directly without the main layout.
 *
 * @param props - The props for the component.
 * @param props.children - The child elements to render within the layout.
 * @returns A React functional component representing the application layout.
 */
export function LayoutWithSidebar({ children }: LayoutWithSidebarProps) {
  const pathname = usePathname();
  const isAuthRoute = AUTH_ROUTES.some((route) => pathname.startsWith(route));
  const isLandingPage = pathname === '/';
  const isChatPage = pathname.startsWith('/chat');

  // Desktop sidebar state - starts closed by default, can be toggled
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  
  const toggleSidebar = React.useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  // Handle sidebar close when a search result is clicked
  const handleSidebarClose = React.useCallback(() => {
    setSidebarOpen(false);
  }, []);

  if (isAuthRoute || isLandingPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header isSidebarOpen={sidebarOpen} toggleSidebar={toggleSidebar} />
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop Sidebar */}
        {sidebarOpen && (
          <div className="hidden md:flex">
            <Sidebar onResultClick={handleSidebarClose} />
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-background">
          <div className={cn('p-4 sm:p-6 lg:p-8', isChatPage && 'p-0')}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}