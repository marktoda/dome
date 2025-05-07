'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { RegisterSchema, RegisterFormData } from '@/lib/validators';
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
// import { useAuth } from '@/contexts/AuthContext'; // Potentially needed if auto-login after register

export default function RegisterPage() {
  const [error, setError] = useState<string | null>(null); // Keep for critical form errors if needed
  // const [successMessage, setSuccessMessage] = useState<string | null>(null); // Replaced by toast
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  // const auth = useAuth(); // Potentially needed

  const form = useForm<RegisterFormData>({
    resolver: zodResolver(RegisterSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  async function onSubmit(data: RegisterFormData) {
    setIsLoading(true);
    setError(null);
    // setSuccessMessage(null); // Replaced by toast
    try {
      // We don't need the confirmPassword field for the API
      const { confirmPassword: _confirmPassword, ...submissionData } = data;
      const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/register` : '/api/auth/register';
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submissionData),
      });

      const result = await response.json();

      if (!response.ok) {
        const errorMessage = result.message || 'Registration failed. Please try again.';
        setError(errorMessage);
        toast.error(errorMessage);
      } else {
        toast.success(result.message || 'Registration successful! You can now log in.');
        // Optionally, redirect to login or auto-login
        // auth.login(result.user); // If API returns user and auto-login is desired
        router.push('/login'); // Redirect to login after successful registration
        form.reset(); // Reset form on success
      }
    } catch (err) {
      const catchMessage = 'An unexpected error occurred. Please try again.';
      setError(catchMessage);
      toast.error(catchMessage);
      console.error('Registration error:', err);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Create an account</CardTitle>
        <CardDescription>
          Create an account to get started.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Your Name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm Password</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error && <p className="text-sm font-medium text-destructive mt-2">{error}</p>}
            {/* {successMessage && <p className="text-sm font-medium text-green-600">{successMessage}</p>} */}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Creating account...' : 'Create account'}
            </Button>
          </form>
        </Form>
      </CardContent>
      <CardFooter className="text-sm">
        Already have an account?{' '}
        <Link href="/login" className="ml-1 underline">
          Login
        </Link>
      </CardFooter>
    </Card>
  );
}