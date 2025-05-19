'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowRight, LogIn, MessageSquarePlus, MessageSquare, Search, Plug } from 'lucide-react';

export default function HomePage() {
  const { user, isLoading } = useAuth();

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <section className="flex flex-1 flex-col items-center justify-center bg-gradient-to-br from-primary/10 to-secondary/10 px-4 text-center">
        <h1 className="mb-4 text-5xl font-bold sm:text-6xl">Dome Knowledge Base</h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Your modern personal exobrain powered by AI.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          <div className="flex flex-col items-center gap-2">
            <MessageSquare className="h-8 w-8 text-primary" />
            <h3 className="text-lg font-semibold">Chat with your knowledge</h3>
            <p className="text-sm text-muted-foreground">Ask questions and get answers from your data.</p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Search className="h-8 w-8 text-primary" />
            <h3 className="text-lg font-semibold">Powerful search</h3>
            <p className="text-sm text-muted-foreground">Find notes and files instantly.</p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Plug className="h-8 w-8 text-primary" />
            <h3 className="text-lg font-semibold">Easy integrations</h3>
            <p className="text-sm text-muted-foreground">Connect services like GitHub or Notion.</p>
          </div>
        </div>
        <div className="mt-8 flex flex-col gap-4 sm:flex-row">
          {isLoading ? (
            <Button disabled size="lg">Loading...</Button>
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
                  <LogIn className="mr-2 h-5 w-5" /> Login
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
      </section>
      <footer className="py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Dome Knowledge Base.
      </footer>
    </div>
  );
}
