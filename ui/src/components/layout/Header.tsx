'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation'; // Import useRouter
import { Button } from '@/components/ui/button';
import { LogOut, Settings } from 'lucide-react'; // Removed Menu icon
import { useAuth } from '@/contexts/AuthContext';
import { MobileSidebar } from '@/components/sidebar/MobileSidebar';

/**
 * Header component displayed at the top of the application.
 * It includes the application name/logo, a mobile sidebar toggle,
 * a link to settings, and a logout button.
 *
 * @returns A React functional component representing the application header.
 */
export function Header() {
  const { logout } = useAuth();
  const router = useRouter();

  /**
   * Handles the user logout process.
   * Calls the `logout` function from `AuthContext` and redirects to the login page on success.
   * Logs an error if logout fails.
   */
  const handleLogout = async () => {
    try {
      await logout();
      router.push('/login');
    } catch (error) {
      console.error('Logout failed:', error);
      // TODO: Implement user-facing notification for logout failure.
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background px-4 sm:px-6">
      <div className="flex items-center gap-4">
        {/* Mobile Menu Toggle - shown only on md and smaller screens */}
        <div className="md:hidden">
          <MobileSidebar />
        </div>
        {/* App Name/Logo */}
        <Link href="/chat" className="text-lg font-semibold">
          Dome Assistant
        </Link>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <Link href="/settings/integrations" passHref>
          <Button variant="ghost" size="icon" aria-label="Settings">
            <Settings className="h-5 w-5" />
          </Button>
        </Link>
        <Button variant="ghost" size="icon" aria-label="Logout" onClick={handleLogout}>
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}