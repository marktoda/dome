'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/sidebar/Sidebar';
// MobileSidebar is now part of Header, so it might not be directly needed here unless used elsewhere
// import { MobileSidebar } from '@/components/sidebar/MobileSidebar';
import { Header } from '@/components/layout/Header'; // Import the new Header

interface LayoutWithSidebarProps {
  children: React.ReactNode;
}

const AUTH_ROUTES = ['/login', '/register', '/forgot-password']; // Add other auth routes if any

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