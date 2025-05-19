'use client';

import { useAuth } from '@/contexts/AuthContext';
import { MessageSquare, Search, Plug } from 'lucide-react';
import { Hero } from '@/components/home/Hero';

export default function HomePage() {
  const { user, isLoading } = useAuth();

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <Hero isLoggedIn={Boolean(user)} isLoading={isLoading} />
      <section className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-16 sm:grid-cols-3">
        <div className="flex flex-col items-center gap-2 text-center">
          <MessageSquare className="h-8 w-8 text-primary" />
          <h3 className="text-lg font-semibold">Chat with your knowledge</h3>
          <p className="text-sm text-muted-foreground">Ask questions and get answers from your data.</p>
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          <Search className="h-8 w-8 text-primary" />
          <h3 className="text-lg font-semibold">Powerful search</h3>
          <p className="text-sm text-muted-foreground">Find notes and files instantly.</p>
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          <Plug className="h-8 w-8 text-primary" />
          <h3 className="text-lg font-semibold">Easy integrations</h3>
          <p className="text-sm text-muted-foreground">Connect services like GitHub or Notion.</p>
        </div>
      </section>
      <footer className="py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Dome Knowledge Base.
      </footer>
    </div>
  );
}
