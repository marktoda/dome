'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GithubIcon, NotionIcon, UserIcon, MailIcon, LockIcon } from '@/components/icons';
import { signIn } from 'next-auth/react';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    try {
      // This would connect to your authentication API
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Registration failed');
      }

      // Login the user after successful registration
      await signIn('credentials', {
        redirect: false,
        email,
        password,
      });

      router.push('/dashboard');
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError('An error occurred during registration');
      }
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthSignIn = (provider: string) => {
    signIn(provider, { callbackUrl: '/dashboard' });
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="auth-card">
        <h1 className="text-2xl font-bold mb-6 text-center">Create an Account</h1>
        
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4" role="alert">
            <span className="block sm:inline">{error}</span>
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="mb-6">
          <div className="form-group">
            <label htmlFor="name" className="form-label">Full Name</label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-gray-500">
                <UserIcon className="w-5 h-5" />
              </span>
              <input
                id="name"
                type="text"
                className="form-input pl-10"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
          </div>
          
          <div className="form-group">
            <label htmlFor="email" className="form-label">Email Address</label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-gray-500">
                <MailIcon className="w-5 h-5" />
              </span>
              <input
                id="email"
                type="email"
                className="form-input pl-10"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>
          
          <div className="form-group">
            <label htmlFor="password" className="form-label">Password</label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-gray-500">
                <LockIcon className="w-5 h-5" />
              </span>
              <input
                id="password"
                type="password"
                className="form-input pl-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
          </div>
          
          <div className="form-group">
            <label htmlFor="confirmPassword" className="form-label">Confirm Password</label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-gray-500">
                <LockIcon className="w-5 h-5" />
              </span>
              <input
                id="confirmPassword"
                type="password"
                className="form-input pl-10"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
          </div>
          
          <button 
            type="submit" 
            className="btn-primary w-full mt-6" 
            disabled={loading}
          >
            {loading ? 'Creating account...' : 'Register'}
          </button>
        </form>
        
        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white text-gray-500">Or continue with</span>
          </div>
        </div>
        
        <div className="flex flex-col gap-3 mb-6">
          <button 
            onClick={() => handleOAuthSignIn('github')}
            className="oauth-button"
          >
            <GithubIcon className="w-5 h-5" />
            <span>GitHub</span>
          </button>
          
          <button 
            onClick={() => handleOAuthSignIn('notion')}
            className="oauth-button"
          >
            <NotionIcon className="w-5 h-5" />
            <span>Notion</span>
          </button>
        </div>
        
        <div className="text-center text-sm">
          <span className="text-gray-600">Already have an account? </span>
          <Link href="/auth/login" className="text-primary hover:underline">
            Login here
          </Link>
        </div>
      </div>
    </main>
  );
}