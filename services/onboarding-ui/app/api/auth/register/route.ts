import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// Registration input validation schema
const registerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
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
    
    // Check if user already exists (mock implementation)
    // In a real implementation, you would check your database
    if (email === 'taken@example.com') {
      return NextResponse.json(
        { success: false, message: 'Email already in use' }, 
        { status: 409 }
      );
    }
    
    // Create user (mock implementation)
    // In a real implementation, you would store in your database
    const user = {
      id: Math.floor(Math.random() * 1000).toString(),
      name,
      email,
      // Note: In a real implementation, you should hash the password
      // password: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
    };
    
    // Return success response (without sensitive data)
    return NextResponse.json(
      { 
        success: true, 
        message: 'Registration successful',
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        }
      }, 
      { status: 201 }
    );
    
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { success: false, message: 'An error occurred during registration' }, 
      { status: 500 }
    );
  }
}