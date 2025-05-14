'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginSchema, LoginFormData } from '@/lib/validators';
import { useAuth, User } from '@/contexts/AuthContext'; // Import User
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
        // Step 1: Check if token is valid
        if (typeof result.token === 'string' && result.token.trim() !== '' && result.token !== 'undefined') {
          const token = result.token;
          console.log('Login page: Token received from API:', token);

          // Step 2: Fetch user data using the token
          try {
            const userApiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/validate` : '/api/auth/validate'; // Changed to /auth/validate
            const userResponse = await fetch(userApiUrl, {
              method: 'POST', // validateTokenRoute is a POST route
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
            });

            if (!userResponse.ok) {
              const userErrorResult = await userResponse.json();
              let userErrorMessage = 'Failed to fetch user details after login.';
              if (userErrorResult && userErrorResult.error && typeof userErrorResult.error.message === 'string') {
                userErrorMessage = userErrorResult.error.message;
              } else if (userErrorResult && typeof userErrorResult.message === 'string') {
                userErrorMessage = userErrorResult.message;
              }
              console.error('Login page: Failed to fetch user data.', userErrorResult);
              setError(userErrorMessage);
              toast.error(userErrorMessage);
              return; // Stop further execution
            }

            const userDataResult = await userResponse.json();
            // Ensure userDataResult.user exists and is a valid User object
            // This check might need to be more robust depending on your API's User structure
            if (userDataResult && userDataResult.user && typeof userDataResult.user.id === 'string') {
              const user: User = userDataResult.user;
              console.log('Login page: User data received from /auth/me:', user);
              auth.login(user, token);
              toast.success('Login successful! Redirecting...');
              router.push('/chat'); // Or to a more appropriate post-login page
            } else {
              const invalidUserDataMessage = 'Login token obtained, but user data from /auth/me is invalid.';
              console.error('Login page: Invalid user data from /auth/me.', userDataResult);
              setError(invalidUserDataMessage);
              toast.error(invalidUserDataMessage);
            }
          } catch (userFetchErr) {
            const userFetchCatchMessage = 'An error occurred while fetching user details. Please try again.';
            setError(userFetchCatchMessage);
            toast.error(userFetchCatchMessage);
            console.error('Login page: Error fetching user details:', userFetchErr);
          }
        } else {
          const invalidTokenMessage = `Login succeeded but token is invalid. Token: ${result.token}`;
          console.error('Login page: Invalid token from API.', result);
          setError(invalidTokenMessage);
          toast.error(invalidTokenMessage);
        }
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