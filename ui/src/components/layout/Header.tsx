'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation'; // Import useRouter
import { Button } from '@/components/ui/button';
import { LogOut, Settings, Menu } from 'lucide-react'; // Assuming lucide-react for icons
import { useAuth } from '@/contexts/AuthContext'; // To handle logout
import { MobileSidebar } from '@/components/sidebar/MobileSidebar'; // For mobile menu toggle

export function Header() {
  const { logout } = useAuth();
  const router = useRouter(); // Initialize useRouter

  const handleLogout = async () => {
    try {
      await logout();
      router.push('/login'); // Redirect to login page after logout
    } catch (error) {
      console.error('Logout failed:', error);
      // Handle logout error (e.g., show a notification)
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