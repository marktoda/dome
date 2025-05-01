'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export default function AuthErrorPage() {
  const searchParams = useSearchParams();
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  useEffect(() => {
    const error = searchParams.get('error');
    
    if (error) {
      switch (error) {
        case 'Configuration':
          setErrorMessage('A server error occurred. Please try again later.');
          break;
        case 'AccessDenied':
          setErrorMessage('Access denied. You might not have permission to sign in with this account.');
          break;
        case 'OAuthSignin':
        case 'OAuthCallback':
        case 'OAuthCreateAccount':
          setErrorMessage('There was a problem with the OAuth authentication.');
          break;
        case 'OAuthAccountNotLinked':
          setErrorMessage('This email is already associated with another account. Please sign in using a different provider.');
          break;
        case 'EmailCreateAccount':
        case 'Callback':
        case 'EmailSignin':
          setErrorMessage('There was a problem with the email authentication.');
          break;
        case 'CredentialsSignin':
          setErrorMessage('Invalid credentials. Please check your email and password and try again.');
          break;
        default:
          setErrorMessage('An unknown authentication error occurred.');
          break;
      }
    } else {
      setErrorMessage('An authentication error occurred.');
    }
  }, [searchParams]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="auth-card text-center">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6" role="alert">
          <p className="font-bold">Authentication Error</p>
          <p>{errorMessage}</p>
        </div>
        
        <div className="flex flex-col gap-4">
          <Link 
            href="/auth/login" 
            className="btn-primary"
          >
            Return to Login
          </Link>
          <Link 
            href="/" 
            className="btn-secondary"
          >
            Go to Home
          </Link>
        </div>
      </div>
    </main>
  );
}