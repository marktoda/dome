'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface HeroProps {
  isLoggedIn: boolean;
  isLoading: boolean;
}

export function Hero({ isLoggedIn, isLoading }: HeroProps) {
  return (
    <section className="relative flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-primary/10 to-secondary/10 px-4 text-center">
      <div className="mx-auto max-w-2xl py-24 sm:py-32 lg:py-40">
        <h1 className="mb-4 text-5xl font-bold sm:text-6xl">Dome Knowledge Base</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
          Your modern personal exobrain powered by AI.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          {isLoading ? (
            <Button disabled size="lg">Loading...</Button>
          ) : isLoggedIn ? (
            <Link href="/chat">
              <Button size="lg" className="group">Go to Chat</Button>
            </Link>
          ) : (
            <>
              <Link href="/register">
                <Button size="lg" className="group">Get Started</Button>
              </Link>
              <Link href="/login">
                <Button size="lg" variant="outline" className="group">Log In</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
