'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginSchema, LoginFormData } from '@/lib/validators';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from "sonner";

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null); // Kept for non-toast errors if any
  const [isLoading, setIsLoading] = useState(false);
  const auth = useAuth();
  const router = useRouter();

  const form = useForm<LoginFormData>({
    resolver: zodResolver(LoginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  async function onSubmit(data: LoginFormData) {
    setIsLoading(true);
    setError(null);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/login` : '/api/auth/login';
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        const errorMessage = result.message || 'Login failed. Please try again.';
        setError(errorMessage); // Set local error state
        toast.error(errorMessage); // Show toast notification
      } else {
        const userWithToken = {
          ...result.user,
          token: result.token
        };
        auth.login(userWithToken);
        toast.success('Login successful! Redirecting...');
        router.push('/chat'); 
      }
    } catch (err) {
      const catchMessage = 'An unexpected error occurred. Please try again.';
      setError(catchMessage);
      toast.error(catchMessage);
      console.error('Login error:', err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Login</CardTitle>
          <CardDescription>
            Enter your email below to login to your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input placeholder="m@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* error state is kept in case of non-toast worthy errors or as a fallback */}
              {error && <p className="text-sm font-medium text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Logging in...' : 'Login'}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="text-sm">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="ml-1 underline">
            Sign up
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}