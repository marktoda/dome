'use client';

import React from 'react';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from '@/components/ui/sheet';
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

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button 
          variant="ghost" 
          size="icon" 
          className="md:hidden"
          aria-label="Open search menu"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent 
        side="left" 
        className="w-80 p-0 [&>[data-slot=sheet-close-button]]:hidden"
      >
        <SheetTitle className="sr-only">Search Navigation</SheetTitle>
        <SheetDescription className="sr-only">Search and navigate through the knowledge base</SheetDescription>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between p-4 border-b">
            <h2 className="text-lg font-semibold">Search</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen(false)}
              aria-label="Close search menu"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close menu</span>
            </Button>
          </div>
          <div className="flex-1">
            <Sidebar onResultClick={() => setOpen(false)} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}