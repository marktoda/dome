import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest
import { cookies } from 'next/headers';
// import * as jose from 'jose'; // No longer needed for direct verification

// const JWT_SECRET = process.env.JWT_SECRET; // No longer needed as verification is delegated
const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

/**
 * Handles GET requests to `/api/auth/me`.
 * Verifies the JWT stored in the `auth_token` HttpOnly cookie.
 * It calls the backend API (`dome-api`) to verify the token and get user details.
 *
 * @param req - The NextRequest object.
 * @returns A NextResponse object with:
 *   - 200 OK: User data ({ user: { id, email, name } }) if the token is successfully verified by the backend.
 *   - 401 Unauthorized: If no token is found, or if the backend API deems the token invalid/expired.
 *                       If the token is invalid, it also attempts to clear the cookie.
 *   - 500 Internal Server Error: If `NEXT_PUBLIC_API_BASE_URL` is not configured, or if there's an unexpected error.
 */
export async function GET(req: NextRequest) {
  if (!DOME_API_URL) {
    console.error(
      'CRITICAL: NEXT_PUBLIC_API_BASE_URL is not defined. Cannot contact backend for token verification.',
    );
    return NextResponse.json(
      { message: 'Server configuration error: API endpoint missing.' },
      { status: 500 },
    );
  }

  const cookieStore = await cookies(); // Re-adding await as it was in original and other files
  const tokenCookie = cookieStore.get('auth_token');

  if (!tokenCookie?.value) {
    console.error('/api/auth/me: No auth_token cookie found.');
    return NextResponse.json({ message: 'Not authenticated: No token found.' }, { status: 401 });
  }

  const token = tokenCookie.value;

  try {
    console.error(
      `/api/auth/me: Forwarding token to ${DOME_API_URL}/auth/verify-token for verification.`,
    );
    const introspectionResponse = await fetch(`${DOME_API_URL}/auth/verify-token`, {
      method: 'GET', // Or POST, depending on your backend API design
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (introspectionResponse.ok) {
      const userData = await introspectionResponse.json();
      // Assuming backend returns { user: { id, email, name } } on success
      if (userData && userData.user) {
        console.error('/api/auth/me: Token verified successfully by backend');
        return NextResponse.json(userData);
      } else {
        console.error(
          '/api/auth/me: Backend token verification successful, but response format is unexpected.',
          userData,
        );
        // Treat as an error, clear cookie
        const errResponse = NextResponse.json(
          { message: 'Not authenticated: Invalid token data from backend.' },
          { status: 401 },
        );
        errResponse.cookies.set({
          name: 'auth_token',
          value: '',
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 0,
        });
        return errResponse;
      }
    } else {
      // If backend says token is invalid (e.g., 401, 403)
      console.error(
        `/api/auth/me: Backend token verification failed with status ${introspectionResponse.status}.`,
      );
      const errorBody = await introspectionResponse
        .json()
        .catch(() => ({ message: 'Invalid or expired token (backend).' }));
      const errResponse = NextResponse.json(
        { message: errorBody.message || 'Not authenticated: Invalid or expired token.' },
        { status: introspectionResponse.status }, // Relay the status from backend
      );
      // Clear the cookie if backend indicates an auth failure (typically 401)
      if (introspectionResponse.status === 401 || introspectionResponse.status === 403) {
        errResponse.cookies.set({
          name: 'auth_token',
          value: '',
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 0,
        });
      }
      return errResponse;
    }
  } catch (error: any) {
    console.error(
      '/api/auth/me: Error during token introspection call to backend:',
      error.message || error,
    );
    // This catches network errors or other issues with the fetch call itself
    return NextResponse.json(
      { message: 'Server error during authentication check.' },
      { status: 500 },
    );
  }
}
