'use client';

import { useState } from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { GithubIcon, NotionIcon } from '@/components/icons';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await signIn('credentials', {
        redirect: false,
        email,
        password,
      });

      if (result?.error) {
        // Display appropriate error message based on error
        if (result.error.includes('not found')) {
          setError('User not found');
        } else if (result.error.includes('credentials')) {
          setError('Invalid email or password');
        } else {
          setError(result.error);
        }
        return;
      }

      router.push('/dashboard');
    } catch (error) {
      setError('An error occurred during login');
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
        <h1 className="text-2xl font-bold mb-6 text-center">Login to Your Account</h1>
        
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4" role="alert">
            <span className="block sm:inline">{error}</span>
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="mb-6">
          <div className="form-group">
            <label htmlFor="email" className="form-label">Email Address</label>
            <input
              id="email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password" className="form-label">Password</label>
            <input
              id="password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          
          <button 
            type="submit" 
            className="btn-primary w-full mt-6" 
            disabled={loading}
          >
            {loading ? 'Logging in...' : 'Login'}
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
          <span className="text-gray-600">Don&apos;t have an account? </span>
          <Link href="/auth/register" className="text-primary hover:underline">
            Register here
          </Link>
        </div>
      </div>
    </main>
  );
}