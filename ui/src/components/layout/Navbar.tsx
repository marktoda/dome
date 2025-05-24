'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, MessageSquare, Search, Settings, Home, LogOut } from 'lucide-react'; // Removed User icon
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useAuth } from '@/contexts/AuthContext';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/**
 * Defines the navigation items for the application.
 * Each item includes a path, a display label, and an icon component.
 */
const navItems = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/settings/integrations', label: 'Settings', icon: Settings },
];

/**
 * `Navbar` component provides the main navigation for the application.
 * It includes:
 * - A mobile-responsive sheet (drawer) menu for smaller screens.
 * - A display of the authenticated user's name and avatar.
 * - A logout button.
 *
 * The navigation links are defined in the `navItems` array.
 * Active links are highlighted based on the current pathname.
 *
 * @returns A React functional component representing the navigation bar.
 */
export function Navbar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const router = useRouter();

  /**
   * Handles the user logout process.
   * Calls the `logout` function from `AuthContext` and redirects to the login page.
   */
  const handleLogout = () => {
    logout(); // This should ideally be an async operation if it involves API calls.
    router.push('/login');
  };

  return (
    <header className="sticky top-0 z-50 flex h-16 items-center gap-4 border-b bg-background px-4 md:px-6 justify-between md:justify-end">
      <Sheet>
        <SheetTrigger className="shrink-0 md:hidden"> {/* Removed asChild and Button, SheetTrigger will render a button */}
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle navigation menu</span>
        </SheetTrigger>
        <SheetContent side="left">
          {/* Using sr-only instead of VisuallyHidden for accessibility */}
          <SheetTitle className="sr-only">Main Navigation</SheetTitle>
          <SheetDescription className="sr-only">Navigate to different sections of the application</SheetDescription>
          <nav className="grid gap-6 text-lg font-medium">
            <Link href="/" className="flex items-center gap-2 text-lg font-semibold mb-4">
              <MessageSquare className="h-6 w-6" />
              <span>App Name</span>
            </Link>
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-all hover:text-primary ${
                  pathname === item.href ? 'text-primary bg-muted' : 'text-muted-foreground'
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
            {user && (
               <Button onClick={handleLogout} variant="ghost" className="flex items-center gap-3 rounded-lg px-3 py-2 text-muted-foreground transition-all hover:text-primary justify-start">
                <LogOut className="h-4 w-4" />
                Logout
              </Button>
            )}
          </nav>
        </SheetContent>
      </Sheet>
      {user && (
        <div className="flex items-center gap-4">
           <span className="text-sm text-muted-foreground hidden sm:inline">Welcome, {user.name}</span>
          <Avatar>
            <AvatarImage src={`https://avatar.vercel.sh/${user.email}.png`} alt={user.name} />
            <AvatarFallback>{user.name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <Button onClick={handleLogout} variant="outline" size="icon" className="hidden md:inline-flex">
            <LogOut className="h-5 w-5" />
            <span className="sr-only">Logout</span>
          </Button>
        </div>
      )}
    </header>
  );
}