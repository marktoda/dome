import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest for type safety
import { cookies } from 'next/headers';

const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

/**
 * Handles POST requests to `/api/auth/logout`.
 * Clears the `auth_token` HttpOnly cookie and notifies the backend to invalidate the token.
 *
 * @param req - The NextRequest object.
 * @returns A NextResponse object with:
 *   - 200 OK: Success message, clearing the auth_token cookie.
 *   - 500 Internal Server Error: If an unexpected error occurs during cookie handling.
 */
export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies(); // Add await back as TS expects a Promise here
    const tokenCookie = cookieStore.get('auth_token');

    // If we have a token and backend URL, notify the backend to invalidate it
    if (tokenCookie?.value && DOME_API_URL) {
      try {
        console.log('Notifying backend to invalidate token');
        await fetch(`${DOME_API_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenCookie.value}`,
            'Content-Type': 'application/json',
          },
        });
        // We don't check the response status - clearing the cookie is the primary action
      } catch (backendError) {
        console.error('Failed to notify backend of logout:', backendError);
        // Continue with cookie clearing even if backend notification fails
      }
    }

    // Always clear the cookie regardless of backend response
    const response = NextResponse.json(
      {
        message: tokenCookie ? 'Logout successful' : 'Logout successful (no active session found)',
      },
      { status: 200 },
    );

    // Clear the auth cookie
    response.cookies.set({
      name: 'auth_token',
      value: '', // Clear the value
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0, // Expire the cookie immediately
    });

    console.log('Logout request processed, clearing auth_token cookie.');
    return response;
  } catch (error) {
    console.error('Logout API route error:', error);
    // Avoid leaking internal error details to the client
    return NextResponse.json(
      { message: 'An internal server error occurred during logout.' },
      { status: 500 },
    );
  }
}
