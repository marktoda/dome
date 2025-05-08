'use client';

import * as React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { SearchInput } from '@/components/search/SearchInput';
import { SearchResultsList } from '@/components/search/SearchResultsList';
import { SearchResultItem, SearchError, SearchResponse } from '@/lib/types/search';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Terminal } from 'lucide-react';

/**
 * `SearchPageContent` handles the core logic and rendering of the search page.
 * It manages search state (query, results, loading, error), interacts with the search API,
 * updates the URL, and displays the appropriate UI based on the state.
 * It's wrapped in `React.Suspense` by the default export `SearchPage` because it uses `useSearchParams`.
 *
 * @returns A React functional component representing the main content of the search page.
 */
function SearchPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Read initial query from URL, useful for direct links or browser history
  const initialQueryFromUrl = searchParams.get('q') || '';

  const [searchResults, setSearchResults] = React.useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<SearchError | null>(null);
  // Keep track of the query that generated the current results/error/loading state
  const [currentQuery, setCurrentQuery] = React.useState<string>(initialQueryFromUrl);

  /**
   * Handles the submission of a new search query.
   * Updates the URL, calls the search API, and manages loading/error/results state.
   * @param query - The search query string entered by the user.
   */
  const handleSearch = React.useCallback(async (query: string) => {
    setIsLoading(true);
    setError(null);
    setCurrentQuery(query); // Update the displayed query immediately

    // Update URL query parameter 'q' without causing a full page reload.
    // This allows sharing search result URLs and uses browser history.
    const params = new URLSearchParams(window.location.search);
    params.set('q', query);
    // Use replace to avoid adding multiple search entries to history for the same page
    router.replace(`${window.location.pathname}?${params.toString()}`);

    try {
      // Call the internal API proxy route
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) {
        // Try to parse error details, provide fallback message
        const errorData: SearchError = await response.json().catch(() => ({ message: `Request failed with status ${response.status}` }));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }
      const data: SearchResponse = await response.json();
      setSearchResults(data.results);
    } catch (err) {
      console.error("Search failed:", err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch search results.';
      setError({ message: errorMessage });
      setSearchResults([]); // Clear results on error
    } finally {
      setIsLoading(false);
    }
  // Include router in dependencies if its identity can change, though usually stable
  }, [router]);

  // Effect to trigger search on initial component mount if a query exists in the URL.
  React.useEffect(() => {
    if (initialQueryFromUrl) {
      // Avoid triggering search if already loading (e.g., from a previous action)
      // Also check if the currentQuery state already matches the URL query
      // to prevent re-searching if the component re-renders for other reasons.
      if (!isLoading && currentQuery !== initialQueryFromUrl) {
         handleSearch(initialQueryFromUrl);
      } else if (!isLoading && !currentQuery && initialQueryFromUrl) {
         // Handle case where component mounts with URL query but state is empty
         handleSearch(initialQueryFromUrl);
      }
    }
  // Run only once on mount, dependency is the initial URL query
  // Adding handleSearch and isLoading to dependencies to reflect their usage,
  // but the logic inside prevents unnecessary calls.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQueryFromUrl, handleSearch, isLoading]); // Refined dependencies

  return (
    // Using a container for consistent padding, adjust as needed
    <div className="container mx-auto px-4 py-8 md:py-12">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Search</h1>
        <p className="mt-2 text-lg text-muted-foreground">
          Find the information you need within our resources.
        </p>
      </header>

      {/* Search Input Component */}
      <div className="mb-8 max-w-2xl mx-auto"> {/* Center search input */}
        <SearchInput onSearch={handleSearch} isLoading={isLoading} initialQuery={currentQuery} />
      </div>

      {/* Conditional Rendering based on state */}
      <div className="mt-8">
        {isLoading && (
          // Loading Skeleton
          <div className="space-y-4">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        )}

        {error && !isLoading && (
          // Error Display
          <Alert variant="destructive" className="max-w-2xl mx-auto">
            <Terminal className="h-4 w-4" />
            <AlertTitle>Search Error</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {!isLoading && !error && currentQuery && searchResults.length > 0 && (
          // Results Display
          <SearchResultsList results={searchResults} />
        )}

        {!isLoading && !error && currentQuery && searchResults.length === 0 && (
          // No Results Message
          <p className="text-center text-muted-foreground py-10">
            No results found for &quot;{currentQuery}&quot;. Try a different search term.
          </p>
        )}

        {!isLoading && !error && !currentQuery && (
          // Initial Prompt Message
          <p className="text-center text-muted-foreground py-10">
            Enter a search term above to find relevant content.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * `SearchPage` is the main export for the search route.
 * It wraps the core `SearchPageContent` in `React.Suspense` to handle
 * the loading state while Next.js hooks like `useSearchParams` resolve.
 *
 * @returns A React functional component for the search page.
 */
export default function SearchPage() {
  return (
    // Suspense is needed because SearchPageContent uses useSearchParams
    <React.Suspense fallback={<SearchPageSkeleton />}>
      <SearchPageContent />
    </React.Suspense>
  );
}

/**
 * `SearchPageSkeleton` provides a basic loading skeleton UI for the search page,
 * shown while `SearchPageContent` is suspended (e.g., while `useSearchParams` resolves).
 *
 * @returns A React functional component rendering the skeleton UI.
 */
function SearchPageSkeleton() {
  return (
    <div className="container mx-auto px-4 py-8 md:py-12 animate-pulse">
      <header className="mb-8 text-center">
        <Skeleton className="h-10 w-1/2 mx-auto rounded-md" />
        <Skeleton className="mt-3 h-6 w-3/4 mx-auto rounded-md" />
      </header>
      <div className="mb-8 max-w-2xl mx-auto">
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
      <div className="space-y-4 mt-8">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}