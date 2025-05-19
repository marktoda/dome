'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowRight, LogIn, MessageSquarePlus, MessageSquare, Search, Plug } from 'lucide-react';

export default function HomePage() {
  const { user, isLoading } = useAuth();

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] p-4 text-center">
      <main className="flex flex-1 flex-col items-center justify-center gap-6">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
          Welcome to Dome Knowledge Base
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground sm:text-xl">
          This is the central hub for all information. Explore features like chat, search, and
          personalized settings.
        </p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="flex flex-col items-center gap-2">
            <MessageSquare className="h-8 w-8 text-primary" />
            <h3 className="text-lg font-semibold">Chat with your knowledge</h3>
            <p className="text-sm text-muted-foreground">
              Ask questions and get answers from your personal data.
            </p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Search className="h-8 w-8 text-primary" />
            <h3 className="text-lg font-semibold">Powerful search</h3>
            <p className="text-sm text-muted-foreground">
              Quickly find notes and files across all your sources.
            </p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Plug className="h-8 w-8 text-primary" />
            <h3 className="text-lg font-semibold">Easy integrations</h3>
            <p className="text-sm text-muted-foreground">
              Connect services like GitHub or Notion in seconds.
            </p>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-4 mt-6">
          {isLoading ? (
            <Button disabled size="lg">
              Loading...
            </Button>
          ) : user ? (
            <Link href="/chat">
              <Button size="lg" className="group">
                Go to Chat
                <ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-1" />
              </Button>
            </Link>
          ) : (
            <>
              <Link href="/login">
                <Button size="lg" variant="outline" className="group">
                  <LogIn className="mr-2 h-5 w-5" />
                  Login
                </Button>
              </Link>
              <Link href="/register">
                <Button size="lg" className="group">
                  Sign Up
                  <MessageSquarePlus className="ml-2 h-5 w-5" />
                </Button>
              </Link>
            </>
          )}
        </div>
      </main>
      <footer className="py-8 text-sm text-muted-foreground">
        © {new Date().getFullYear()} Dome Knowledge Base. All rights reserved.
      </footer>
    </div>
  );
}
