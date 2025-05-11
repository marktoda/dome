import { NextRequest, NextResponse } from 'next/server';
import { SearchResponse } from '@/lib/types/search';

/**
 * The URL of the external backend API responsible for handling search queries.
 * TODO: Consider moving this to environment variables for better configuration.
 */
const EXTERNAL_SEARCH_API_URL = 'https://dome-api.chatter-9999.workers.dev/search';

/**
 * Handles GET requests to `/api/search`.
 * This route acts as an authenticated proxy to an external search API.
 * It forwards the search query (`q`) and optional `category` parameter,
 * along with the user's `Authorization` header, to the external API.
 *
 * @param request - The incoming NextRequest object.
 * @returns A NextResponse object containing:
 *   - 200 OK: The JSON response from the external search API on success.
 *   - 400 Bad Request: If the required 'q' query parameter is missing.
 *   - 401 Unauthorized: If the 'Authorization' header is missing or invalid.
 *   - Matching status code from external API: If the external API returns an error (e.g., 4xx, 5xx).
 *   - 500 Internal Server Error: If an unexpected error occurs during the proxy process.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');
  const category = searchParams.get('category'); // Optional category filter

  // Validate required query parameter
  if (!query) {
    return NextResponse.json(
      { message: 'Bad Request: Query parameter "q" is required.' },
      { status: 400 },
    );
  }

  // Extract and validate Authorization header
  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader) {
    console.warn('/api/search: Missing Authorization header.');
    return NextResponse.json(
      { message: 'Unauthorized: Authorization header required.' },
      { status: 401 },
    );
  }

  // Assuming Bearer token format
  const token = authorizationHeader.startsWith('Bearer ') ? authorizationHeader.substring(7) : null;

  if (!token) {
    console.warn('/api/search: Invalid or missing Bearer token in Authorization header.');
    return NextResponse.json({ message: 'Unauthorized: Invalid token format.' }, { status: 401 });
  }

  // Construct the URL for the external API request
  const externalApiUrl = new URL(EXTERNAL_SEARCH_API_URL);
  externalApiUrl.searchParams.append('q', query);
  if (category) {
    externalApiUrl.searchParams.append('category', category);
  }

  console.log(`Proxying search request to: ${externalApiUrl.toString()}`);

  try {
    // Make the request to the external API, forwarding the token
    const apiResponse = await fetch(externalApiUrl.toString(), {
      method: 'GET',
      headers: {
        // Forward the original Authorization header (including 'Bearer ')
        Authorization: authorizationHeader,
        'Content-Type': 'application/json', // Usually not needed for GET, but common practice
        // Add other necessary headers if required by the external API
      },
    });

    // Check if the external API request was successful
    if (!apiResponse.ok) {
      // Attempt to read error details from the external API response
      let errorDetails = `Status code ${apiResponse.status}`;
      try {
        errorDetails = await apiResponse.text(); // Get raw text for more info
      } catch (_) {
        // Ignore error reading body if it fails
      }
      console.error(
        `External search API error: ${apiResponse.status} ${apiResponse.statusText}. Details: ${errorDetails}`,
      );
      // Forward the error status and a generic message (or specific details if safe)
      return NextResponse.json(
        {
          message: `Error from external search API: ${apiResponse.statusText}`,
          // Avoid forwarding raw errorDetails directly unless sanitized or known to be safe
        },
        { status: apiResponse.status },
      );
    }

    // Parse the successful JSON response from the external API
    const data: SearchResponse = await apiResponse.json();

    // Return the successful response to the original client
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error calling external search API:', error);
    let errorMessage = 'Internal Server Error';
    if (error instanceof Error) {
      // Avoid leaking potentially sensitive details from the error message
      errorMessage = 'Failed to connect to the external search service.';
    }
    return NextResponse.json(
      { message: 'Failed to fetch search results due to an internal error.', error: errorMessage },
      { status: 502 }, // 502 Bad Gateway is often appropriate for proxy errors
    );
  }
}
