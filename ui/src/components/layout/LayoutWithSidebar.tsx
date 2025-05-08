'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
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
const AUTH_ROUTES = ['/login', '/register', '/forgot-password']; // Add other auth routes if any

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

  if (isAuthRoute || isLandingPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen flex-col"> {/* Changed to flex-col for header on top */}
      <Header /> {/* Add the new Header component here */}
      <div className="flex flex-1 overflow-hidden"> {/* Container for sidebar and main content */}
        {/* Desktop Sidebar */}
        <div className="hidden md:flex">
          <Sidebar />
        </div>

        {/* Main Content Area */}
        {/* Removed sticky header from here as it's now a global Header component */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 md:p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}