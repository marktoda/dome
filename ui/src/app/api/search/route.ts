import { NextRequest, NextResponse } from 'next/server';
import { SearchResponse } from '@/lib/types/search';

const EXTERNAL_SEARCH_API_URL = 'https://dome-api.chatter-9999.workers.dev/search';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');
  const category = searchParams.get('category');

  if (!query) {
    return NextResponse.json({ message: 'Query parameter "q" is required' }, { status: 400 });
  }

  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const token = authorizationHeader.replace('Bearer ', '');
  if (!token) {
    return NextResponse.json({ message: 'Unauthorized: Token not found' }, { status: 401 });
  }

  const externalApiUrl = new URL(EXTERNAL_SEARCH_API_URL);
  externalApiUrl.searchParams.append('q', query);
  if (category) {
    externalApiUrl.searchParams.append('category', category);
  }

  try {
    const apiResponse = await fetch(externalApiUrl.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!apiResponse.ok) {
      const errorData = await apiResponse.text();
      console.error(
        `External API error: ${apiResponse.status} ${apiResponse.statusText}`,
        errorData,
      );
      return NextResponse.json(
        {
          message: `Error from external search API: ${apiResponse.statusText}`,
          details: errorData,
        },
        { status: apiResponse.status },
      );
    }

    const data: SearchResponse = await apiResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error calling external search API:', error);
    let errorMessage = 'Internal Server Error';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return NextResponse.json(
      { message: 'Failed to fetch search results', error: errorMessage },
      { status: 500 },
    );
  }
}
