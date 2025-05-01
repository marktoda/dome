import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { authClient } from '../../../../lib/authClient';

// Configure route to use Edge Runtime for Cloudflare Pages compatibility
export const runtime = 'edge';

export async function POST(req: NextRequest) {
  try {
    // Get the NextAuth token from the request
    const token = await getToken({ 
      req,
      secret: process.env.NEXTAUTH_SECRET
    });

    if (!token || !token.accessToken) {
      return NextResponse.json({ success: false, message: 'No valid session' }, { status: 401 });
    }

    // Call the auth service to invalidate the token
    try {
      await authClient.logout(token.accessToken);
      
      return NextResponse.json({
        success: true,
        message: 'Logged out successfully'
      });
    } catch (error) {
      console.error('Error calling auth service logout:', error);
      // Even if the auth service fails, we'll still consider this a success
      // from the frontend perspective, as the NextAuth session will be destroyed
      return NextResponse.json({
        success: true,
        message: 'Session ended'
      });
    }
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { success: false, message: 'An error occurred during logout' }, 
      { status: 500 }
    );
  }
}

