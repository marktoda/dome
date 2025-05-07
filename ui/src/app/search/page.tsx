'use client';

import * as React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { SearchInput } from '@/components/search/SearchInput';
import { SearchResultsList } from '@/components/search/SearchResultsList';
import { SearchResultItem, SearchError, SearchResponse } from '@/lib/types/search';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Terminal } from 'lucide-react';

function SearchPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQueryFromUrl = searchParams.get('q') || '';

  const [searchResults, setSearchResults] = React.useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<SearchError | null>(null);
  const [currentQuery, setCurrentQuery] = React.useState<string>(initialQueryFromUrl);

  const handleSearch = async (query: string) => {
    setIsLoading(true);
    setError(null);
    setCurrentQuery(query);

    // Update URL without reloading page
    const params = new URLSearchParams(window.location.search);
    params.set('q', query);
    router.replace(`${window.location.pathname}?${params.toString()}`);

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) {
        const errorData: SearchError = await response.json().catch(() => ({ message: 'An unknown error occurred.' }));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }
      const data: SearchResponse = await response.json();
      setSearchResults(data.results);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch search results.';
      setError({ message: errorMessage });
      setSearchResults([]); // Clear results on error
    } finally {
      setIsLoading(false);
    }
  };

  // Perform search on initial load if query is present in URL
  React.useEffect(() => {
    if (initialQueryFromUrl) {
      handleSearch(initialQueryFromUrl);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount if initialQueryFromUrl is present

  return (
    <div className="container mx-auto px-4 py-8">
      <header className="mb-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Search</h1>
        <p className="mt-2 text-lg text-muted-foreground">
          Find the information you need within our resources.
        </p>
      </header>

      <div className="mb-8">
        <SearchInput onSearch={handleSearch} isLoading={isLoading} initialQuery={currentQuery} />
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {error && !isLoading && (
         <Alert variant="destructive">
           <Terminal className="h-4 w-4" />
           <AlertTitle>Error</AlertTitle>
           <AlertDescription>{error.message}</AlertDescription>
         </Alert>
      )}

      {!isLoading && !error && currentQuery && searchResults.length > 0 && (
        <SearchResultsList results={searchResults} />
      )}

      {!isLoading && !error && currentQuery && searchResults.length === 0 && (
        <p className="text-center text-muted-foreground">
          No results found for &quot;{currentQuery}&quot;. Try a different search term.
        </p>
      )}

      {!isLoading && !error && !currentQuery && (
        <p className="text-center text-muted-foreground">
          Enter a search term above to find relevant content.
        </p>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <React.Suspense fallback={<SearchPageSkeleton />}>
      <SearchPageContent />
    </React.Suspense>
  );
}

// Basic skeleton for the search page while content is loading
function SearchPageSkeleton() {
  return (
    <div className="container mx-auto px-4 py-8">
      <header className="mb-8 text-center">
        <Skeleton className="h-10 w-1/2 mx-auto" />
        <Skeleton className="mt-2 h-6 w-3/4 mx-auto" />
      </header>
      <div className="mb-8">
        <Skeleton className="h-12 w-full" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}