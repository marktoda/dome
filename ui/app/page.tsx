import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="auth-card text-center">
        <h1 className="text-3xl font-bold mb-8">Welcome to Dome</h1>
        <p className="text-lg mb-8">
          A simple onboarding portal with GitHub and Notion OAuth integration.
        </p>
        <div className="flex flex-col gap-4">
          <Link 
            href="/auth/login" 
            className="btn-primary"
          >
            Login
          </Link>
          <Link 
            href="/auth/register" 
            className="btn-secondary"
          >
            Register
          </Link>
        </div>
      </div>
    </main>
  );
}