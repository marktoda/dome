import { NextRequest, NextResponse } from 'next/server';
import { authClient } from '../../../../lib/authClient';
import { AuthErrorCode } from '../../../../lib/authTypes';
import { z } from 'zod';

// Configure route to use Edge Runtime for Cloudflare Pages compatibility
export const runtime = "experimental-edge";

// Registration input validation schema
const registerSchema = z.object({
  name: z.string().optional(),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    // Validate input data
    const result = registerSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'Validation failed', 
          errors: result.error.errors 
        }, 
        { status: 400 }
      );
    }
    
    const { name, email, password } = result.data;
    
    // Call the actual auth service to register the user
    try {
      const registerResponse = await authClient.register(email, password, name);
      
      // Return success response
      return NextResponse.json(
        { 
          success: true, 
          message: 'Registration successful',
          user: {
            id: registerResponse.user.id,
            name: registerResponse.user.name,
            email: registerResponse.user.email,
          }
        }, 
        { status: 201 }
      );
    } catch (error: unknown) {
      // Handle specific error cases from the auth service
      const errorMessage = error instanceof Error ? error.message : 'Registration failed';
      
      if (errorMessage.includes(AuthErrorCode.USER_EXISTS)) {
        return NextResponse.json(
          { success: false, message: 'Email already in use' }, 
          { status: 409 }
        );
      }
      
      throw error; // Let the general error handler catch other errors
    }
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { success: false, message: 'An error occurred during registration' }, 
      { status: 500 }
    );
  }
}
