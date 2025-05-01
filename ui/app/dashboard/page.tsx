'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { auth, signOut } from '@/auth';
import { useSession } from 'next-auth/react';

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/auth/login');
    } else if (status === 'authenticated') {
      setLoading(false);
    }
  }, [status, router]);

  if (loading) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-4">Loading dashboard...</h2>
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col p-6">
      <header className="flex justify-between items-center mb-8 p-4 bg-white shadow rounded-lg">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <button
          onClick={async () => {
            // First call our custom logout API to revoke the token on the server
            try {
              await fetch('/api/auth/logout', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
              });
            } catch (error) {
              console.error('Error during logout:', error);
            }
            
            // Then use Auth.js v5 signOut to clear local session
            signOut({ redirectTo: '/' });
          }}
          className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-md transition-colors"
        >
          Sign Out
        </button>
      </header>

      <div className="bg-white shadow rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Welcome, {session?.user?.name || 'User'}!</h2>
        <div className="flex items-center space-x-4">
          {session?.user?.image && (
            <Image
              src={session.user.image}
              alt={`${session.user.name || 'User'}'s profile`}
              width={64}
              height={64}
              className="rounded-full"
            />
          )}
          <div>
            <p className="text-gray-600">Email: {session?.user?.email}</p>
            <p className="text-gray-600">User ID: {session?.user?.id}</p>
            {session?.user?.role && (
              <p className="text-gray-600">Role: {session.user.role}</p>
            )}
            {session?.provider && (
              <p className="text-gray-600">Logged in with: {session.provider}</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Getting Started</h3>
          <p className="text-gray-600 mb-4">
            This is a simple dashboard after successful authentication. In a real application, you would see your data and actions here.
          </p>
          <ul className="list-disc pl-5 text-gray-600">
            <li className="mb-2">Customize your profile</li>
            <li className="mb-2">Explore available features</li>
            <li className="mb-2">Invite team members</li>
            <li className="mb-2">Check out documentation</li>
          </ul>
        </div>

        <div className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Connected Accounts</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center mr-3">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                </div>
                <div>
                  <p className="font-medium">GitHub</p>
                  <p className="text-sm text-gray-500">
                    {session?.provider === 'github' ? 'Connected' : 'Not connected'}
                  </p>
                </div>
              </div>
              <button className="text-sm text-primary hover:underline">
                {session?.provider === 'github' ? 'Disconnect' : 'Connect'}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center mr-3">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.401-.093-1.962-.747l-1.962-2.055c-.56-.653-.793-1.026-.793-1.866V4.114c0-1.493.886-2.986 2.428-3.079z" />
                  </svg>
                </div>
                <div>
                  <p className="font-medium">Notion</p>
                  <p className="text-sm text-gray-500">
                    {session?.provider === 'notion' ? 'Connected' : 'Not connected'}
                  </p>
                </div>
              </div>
              <button className="text-sm text-primary hover:underline">
                {session?.provider === 'notion' ? 'Disconnect' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}