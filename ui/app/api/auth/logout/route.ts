import { NextRequest, NextResponse } from 'next/server';
import { signOut } from '@/auth';
import { authClient } from '../../../../lib/authClient';

// Configure route to use Edge Runtime for Cloudflare Pages compatibility
export const runtime = 'experimental-edge';

export async function POST(req: NextRequest) {
  try {
    // Get the session token from the cookie
    const authToken = req.cookies.get('auth-token')?.value;

    if (authToken) {
      // Call the auth service to invalidate the token
      try {
        await authClient.logout(authToken);
      } catch (error) {
        console.error('Error calling auth service logout:', error);
        // Continue anyway, as we'll still clear the session
      }
    }

    // Use Auth.js v5 signOut to clear the session
    await signOut({ redirect: false });

    return NextResponse.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { success: false, message: 'An error occurred during logout' },
      { status: 500 },
    );
  }
}
