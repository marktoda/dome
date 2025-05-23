'use client';

import React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Sidebar } from './Sidebar';

/**
 * `MobileSidebar` provides a toggle button (hamburger menu icon) that, when clicked,
 * opens a sheet (drawer) from the left side of the screen, displaying the main {@link Sidebar}.
 * This component is intended for use on smaller screens (mobile and tablet) where the
 * full sidebar is hidden by default.
 *
 * @returns A React functional component representing the mobile sidebar toggle and sheet.
 */
export function MobileSidebar() {
  const [open, setOpen] = React.useState(false);
  const handleResultClick = React.useCallback(() => setOpen(false), []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu />
          <span className="sr-only">Toggle Menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="p-0 w-72"> {/* Removed pt-6, Sidebar will handle its padding. Explicitly set width. */}
        <Sidebar onResultClick={handleResultClick} />
      </SheetContent>
    </Sheet>
  );
}