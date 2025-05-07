import { NextRequest, NextResponse } from 'next/server';

// Ensure DOME_API_URL is set in your environment variables
const DOME_API_URL = process.env.DOME_API_URL || 'http://localhost:8787'; 

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  if (!id) {
    return NextResponse.json({ error: 'Note ID is required' }, { status: 400 });
  }

  // The token should be included in the Authorization header by the apiClient
  const authorizationHeader = request.headers.get('Authorization');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (authorizationHeader) {
    headers['Authorization'] = authorizationHeader;
  }
  // Add other headers if required by your backend, e.g., 'x-api-key' for legacy
  // if (process.env.DOME_API_KEY) { // Example for a static API key if needed
  //   headers['x-api-key'] = process.env.DOME_API_KEY;
  // }


  try {
    const response = await fetch(`${DOME_API_URL}/notes/${id}`, {
      method: 'GET',
      headers: headers,
    });

    if (!response.ok) {
      const errorData = await response.text(); // Use text() first to avoid JSON parse error if response is not JSON
      console.error(`Error fetching note ${id} from backend:`, response.status, errorData);
      // Attempt to parse as JSON if content type suggests it, otherwise return raw text
      let details = errorData;
      try {
        if (response.headers.get('content-type')?.includes('application/json')) {
          details = JSON.parse(errorData);
        }
      } catch (parseError) {
        // Ignore if not JSON, details will remain as text
      }
      return NextResponse.json(
        { error: `Failed to fetch note: ${response.statusText}`, details },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error(`Error proxying /api/notes/${id}:`, error);
    let errorMessage = 'Internal Server Error';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return NextResponse.json({ error: 'Failed to proxy request to backend', details: errorMessage }, { status: 500 });
  }
}