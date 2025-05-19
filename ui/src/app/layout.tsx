import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans'; // Updated import
import { GeistMono } from 'geist/font/mono'; // Updated import
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { LayoutWithSidebar } from '@/components/layout/LayoutWithSidebar';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme-provider';

// Removed Geist and Geist_Mono direct font loading, using GeistSans and GeistMono from geist/font

export const metadata: Metadata = {
  title: 'Dome Knowledge Base',
  description: 'The Dome Knowledge Base.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <ThemeProvider>
          <AuthProvider>
            <LayoutWithSidebar>{children}</LayoutWithSidebar>
            <Sonner />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
