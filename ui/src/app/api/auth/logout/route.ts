import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest for type safety
import { cookies } from 'next/headers';

/**
 * Handles POST requests to `/api/auth/logout`.
 * Clears the `auth_token` HttpOnly cookie to log the user out.
 *
 * @param req - The NextRequest object (unused in this implementation but good practice to type).
 * @returns A NextResponse object with:
 *   - 200 OK: Success message, regardless of whether a token cookie was initially present.
 *             The response includes instructions to clear the `auth_token` cookie.
 *   - 500 Internal Server Error: If an unexpected error occurs during cookie handling.
 */
export async function POST(req: NextRequest) {
  // Changed type to NextRequest
  try {
    const cookieStore = await cookies(); // Add await back as TS expects a Promise here
    const tokenCookie = cookieStore.get('auth_token');

    // Prepare the response - we always want to try clearing the cookie
    const response = NextResponse.json(
      {
        message: tokenCookie ? 'Logout successful' : 'Logout successful (no active session found)',
      },
      { status: 200 },
    );

    // Instruct the browser to clear the cookie by setting its value to empty and maxAge to 0
    response.cookies.set({
      name: 'auth_token',
      value: '', // Clear the value
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0, // Expire the cookie immediately
    });

    console.error('Logout request processed, clearing auth_token cookie.');
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
