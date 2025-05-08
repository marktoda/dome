import { NextRequest, NextResponse } from 'next/server';

/**
 * Base URL for the backend Dome API service.
 * Reads from the `DOME_API_URL` environment variable, falling back to localhost.
 */
const DOME_API_URL = process.env.DOME_API_URL ?? 'http://localhost:8787';

/**
 * Handles GET requests to `/api/notes/[id]`.
 * This route acts as a proxy to fetch a specific note from the backend Dome API.
 * It forwards the `Authorization` header from the original request to the backend.
 *
 * @param request - The incoming NextRequest object.
 * @param context - Context object containing route parameters.
 * @param context.params - Object containing dynamic route parameters.
 * @param context.params.id - The ID of the note to fetch, extracted from the URL path.
 * @returns A NextResponse object containing the backend's response (status, headers, body).
 */
export async function GET(
  request: NextRequest,
  context: { params: { id: string } } // More specific type for context
) {
  const id = context.params.id;

  if (!id) {
    // This case should technically not be reachable if the route definition is correct,
    // but it's good practice to check.
    console.error('Note ID missing in route parameters.');
    return NextResponse.json({ error: 'Bad Request: Note ID is required in the URL path.' }, { status: 400 });
  }

  const backendUrl = `${DOME_API_URL}/notes/${encodeURIComponent(id)}`;
  console.log(`Proxying GET request for note ID ${id} to ${backendUrl}`);

  try {
    // Forward the request to the backend API
    const domeResponse = await fetch(backendUrl, {
      method: 'GET', // Explicitly set method
      headers: {
        // Forward essential headers, especially Authorization
        'Content-Type': 'application/json', // Usually not needed for GET, but doesn't hurt
        'Authorization': request.headers.get('Authorization') ?? '', // Forward token
        // Add any other headers required by the backend if necessary
      },
      // `credentials: 'include'` is generally not needed when forwarding Authorization header
      // unless the backend specifically relies on cookies from the *frontend's* domain
      // being sent to the *backend's* domain, which requires careful CORS setup.
    });

    // Stream the backend response body directly to the client
    const body = await domeResponse.text(); // Read body as text first

    // Construct a new response with the status and headers from the backend response
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', domeResponse.headers.get('content-type') ?? 'application/json');
    // Optionally forward other relevant headers from domeResponse.headers if needed

    return new NextResponse(body, {
      status: domeResponse.status,
      statusText: domeResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[API Proxy Error] Failed fetching ${backendUrl}:`, error);
    // Avoid leaking internal details in the error response
    return NextResponse.json({ error: 'Internal Server Error while contacting backend service.' }, { status: 502 }); // 502 Bad Gateway might be more appropriate
  }
}
