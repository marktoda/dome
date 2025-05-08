import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { cookies } from 'next/headers';
import * as jose from 'jose';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Handles GET requests to `/api/auth/me`.
 * Verifies the JWT stored in the `auth_token` HttpOnly cookie.
 * If the token is valid, it returns the user's information extracted from the token payload.
 *
 * @param req - The NextRequest object (unused but typed for consistency).
 * @returns A NextResponse object with:
 *   - 200 OK: User data ({ user: { id, email, name } }) if the token is valid.
 *   - 401 Unauthorized: If no token is found or the token is invalid/expired.
 *                       If the token is invalid, it also attempts to clear the cookie.
 *   - 500 Internal Server Error: If the JWT_SECRET is not configured.
 */
export async function GET(req: NextRequest) { // Changed type to NextRequest
  if (!JWT_SECRET) {
    console.error('CRITICAL: JWT_SECRET is not defined in environment variables for /api/auth/me.');
    return NextResponse.json({ message: 'Server configuration error: JWT secret missing.' }, { status: 500 });
  }

  const cookieStore = await cookies(); // Keep await based on logout route fix
  const tokenCookie = cookieStore.get('auth_token');

  if (!tokenCookie?.value) {
    console.log('/api/auth/me: No auth_token cookie found.');
    return NextResponse.json({ message: 'Not authenticated: No token found.' }, { status: 401 });
  }

  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    // Verify the JWT and extract the payload
    const { payload } = await jose.jwtVerify(tokenCookie.value, secret);

    // Ensure the payload contains the expected user information
    // Adjust property names (e.g., payload.sub for id) if using standard JWT claims
    const userId = payload.userId as string | undefined;
    const email = payload.email as string | undefined;
    const name = payload.name as string | undefined;

    if (!userId || !email || !name) {
        console.error('JWT payload verification failed: Missing expected claims (userId, email, name). Payload:', payload);
        throw new Error('Invalid token payload structure.'); // Treat as verification failure
    }

    console.log(`/api/auth/me: Token verified successfully for user: ${email}`);
    // Return the user data extracted from the token
    return NextResponse.json({
      user: {
        id: userId,
        email: email,
        name: name
      }
    });

  } catch (error: any) {
    // Handle errors during JWT verification (e.g., expired, invalid signature)
    console.error('JWT verification failed for /api/auth/me:', error.message || error);

    // Prepare a response indicating unauthorized access
    const response = NextResponse.json({ message: 'Not authenticated: Invalid or expired token.' }, { status: 401 });

    // Instruct the browser to clear the invalid/expired cookie
    response.cookies.set({
      name: 'auth_token',
      value: '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0, // Expire immediately
    });

    return response;
  }
}
