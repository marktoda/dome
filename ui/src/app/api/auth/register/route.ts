import { NextRequest, NextResponse } from 'next/server';
import { RegisterSchema } from '@/lib/validators';

const DOME_API_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

/**
 * Handles POST requests to `/api/auth/register`.
 * Proxies registration requests to the backend dome-api service.
 *
 * @param req - The NextRequest object containing the request details.
 * @returns A NextResponse object with:
 *   - 201 Created: User data and token from backend on successful registration.
 *   - 400 Bad Request: Validation errors if request body is invalid.
 *   - 409 Conflict: If a user with the provided email already exists.
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
    const validation = RegisterSchema.safeParse(body);

    if (!validation.success) {
      console.error('Registration validation failed:', validation.error.flatten());
      return NextResponse.json(
        { message: 'Invalid request body.', errors: validation.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { name, email, password } = validation.data;

    console.log(`Proxying registration request to backend: ${DOME_API_URL}/auth/register`);

    // Proxy the request to the backend
    const backendResponse = await fetch(`${DOME_API_URL}/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, email, password }),
    });

    const backendData = await backendResponse.json();

    if (!backendResponse.ok) {
      console.error('Backend registration failed:', backendData);
      return NextResponse.json(
        { message: backendData.message || 'Registration failed' },
        { status: backendResponse.status },
      );
    }

    console.log('Backend registration successful');

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
              message: 'Registration successful' 
            }, { status: 201 });

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
        console.error('Failed to fetch user data after registration:', userError);
      }
    }

    // Fallback if user data fetch fails
    const response = NextResponse.json({ 
      token: backendData.token,
      message: 'Registration successful' 
    }, { status: 201 });

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
    console.error('Register API route error:', error);
    return NextResponse.json(
      { message: 'An unexpected internal server error occurred.' },
      { status: 500 },
    );
  }
}
