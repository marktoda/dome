'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Sidebar, SIDEBAR_WIDTH_CLASS } from './Sidebar';
import { useDisclosure } from '@/hooks/useDisclosure';

/**
 * `MobileSidebar` provides a toggle button (hamburger menu icon) that, when clicked,
 * opens a sheet (drawer) from the left side of the screen, displaying the main {@link Sidebar}.
 * This component is intended for use on smaller screens (mobile and tablet) where the
 * full sidebar is hidden by default.
 *
 * @returns A React functional component representing the mobile sidebar toggle and sheet.
 */
export function MobileSidebar() {
  const { isOpen, open, close } = useDisclosure();
  const pathname = usePathname();
  const handleResultClick = React.useCallback(() => close(), [close]);

  React.useEffect(() => {
    // Close the sidebar whenever navigation occurs
    close();
  }, [pathname, close]);

  return (
    <Sheet open={isOpen} onOpenChange={(v) => (v ? open() : close())}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu />
          <span className="sr-only">Toggle Menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className={`p-0 ${SIDEBAR_WIDTH_CLASS}`}> {/* Match sidebar width so close button remains accessible */}
        <Sidebar onResultClick={handleResultClick} />
      </SheetContent>
    </Sheet>
  );
}
