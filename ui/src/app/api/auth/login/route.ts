import { NextRequest, NextResponse } from 'next/server';
import { LoginSchema } from '@/lib/validators';

const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

/**
 * Handles POST requests to `/api/auth/login`.
 * Proxies login requests to the backend dome-api service.
 * 
 * @param req - The NextRequest object containing the request details.
 * @returns A NextResponse object with:
 *   - 200 OK: User data and token from backend on successful login.
 *   - 400 Bad Request: Validation errors if request body is invalid.
 *   - 401 Unauthorized: If email/password combination is incorrect.
 *   - 500 Internal Server Error: If backend is unavailable or other server errors occur.
 */
export async function POST(req: NextRequest) {
  try {
    if (!DOME_API_URL) {
      console.error('CRITICAL: NEXT_PUBLIC_API_BASE_URL is not defined in environment variables.');
      return NextResponse.json(
        { message: 'Server configuration error: Backend API endpoint missing.' },
        { status: 500 },
      );
    }

    const body = await req.json();
    const validation = LoginSchema.safeParse(body);

    if (!validation.success) {
      console.error('Login validation failed:', validation.error.flatten());
      return NextResponse.json(
        { message: 'Invalid request body.', errors: validation.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { email, password } = validation.data;

    console.log(`Proxying login request to backend: ${DOME_API_URL}/auth/login`);

    // Proxy the request to the backend
    const backendResponse = await fetch(`${DOME_API_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    const backendData = await backendResponse.json();

    if (!backendResponse.ok) {
      console.error('Backend login failed:', backendData);
      return NextResponse.json(
        { message: backendData.message || 'Login failed' },
        { status: backendResponse.status },
      );
    }

    console.log('Backend login successful');

    // The backend returns { token: string }
    // We need to also fetch user data using the token to match the expected UI response format
    if (backendData.token) {
      try {
        const userResponse = await fetch(`${DOME_API_URL}/auth/validate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${backendData.token}`,
            'Content-Type': 'application/json',
          },
        });

        if (userResponse.ok) {
          const userData = await userResponse.json();
          if (userData.success && userData.user) {
            // Set the token in an HttpOnly cookie for security
            const response = NextResponse.json({ 
              user: userData.user, 
              token: backendData.token, // Include token in response for frontend state
              message: 'Login successful' 
            });

            response.cookies.set({
              name: 'auth_token',
              value: backendData.token,
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              path: '/',
              maxAge: 2 * 60 * 60, // 2 hours in seconds
            });

            return response;
          }
        }
      } catch (userError) {
        console.error('Failed to fetch user data after login:', userError);
      }
    }

    // Fallback if user data fetch fails
    const response = NextResponse.json({ 
      token: backendData.token,
      message: 'Login successful' 
    });

    response.cookies.set({
      name: 'auth_token',
      value: backendData.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 2 * 60 * 60, // 2 hours in seconds
    });

    return response;

  } catch (error) {
    console.error('Login API route error:', error);
    return NextResponse.json(
      { message: 'An unexpected internal server error occurred.' },
      { status: 500 },
    );
  }
}
