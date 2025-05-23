import React, { useState } from 'react';
import { toast } from 'sonner'; // Added toast import
import { SearchInput } from '@/components/search/SearchInput';
import { SearchResultsList } from '@/components/search/SearchResultsList';
import { searchApi } from '@/lib/api';
import { SearchResultItem } from '@/lib/types/search';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Terminal, Loader2 } from 'lucide-react'; // Added Loader2
import { cn } from '@/lib/utils';

/**
 * Props for the {@link Sidebar} component.
 */
interface SidebarProps {
  /** Optional additional CSS class names for the sidebar container. */
  className?: string;
  /** Callback when a search result is selected. */
  onResultClick?: () => void;
}

/**
 * `Sidebar` component provides a dedicated area for search functionality.
 * It includes a {@link SearchInput} to enter queries and a {@link SearchResultsList}
 * to display the results. It manages loading states, error messages, and "no results" feedback.
 *
 * @param props - The props for the component.
 * @param props.className - Optional additional CSS class names for the sidebar container.
 * @returns A React functional component representing the application sidebar.
 */
export function Sidebar({ className, onResultClick }: SidebarProps) {
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<string>('');

  /**
   * Handles the search operation.
   * If the query is empty, it clears results and errors.
   * Otherwise, it sets loading state, calls the search API, and updates
   * search results or error state accordingly.
   * @param query - The search query string.
   */
  const handleSearch = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setError(null);
      setLastQuery('');
      return;
    }
    setIsLoading(true);
    setError(null); // Clear previous errors before new search
    setLastQuery(query);
    try {
      const response = await searchApi.search(query);
      setSearchResults(response.results);
      if (response.results.length === 0) {
        // Optionally, toast if you want to notify for "no results" specifically
        // toast.info(`No results found for "${query}"`);
      }
    } catch (err) {
      console.error('Search API error:', err);
      const errorMessage = 'Failed to fetch search results. Please try again.';
      setError(errorMessage);
      toast.error(errorMessage); // Add toast notification for search error
      setSearchResults([]); // Clear previous results on error
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <aside className={cn("h-full w-80 flex-col border-r bg-background p-4 flex", className)}>
      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">Search</h2>
      </div>
      <SearchInput onSearch={handleSearch} isLoading={isLoading} />
      
      <div className="mt-4 flex-grow overflow-y-auto pr-1">
        {isLoading && searchResults.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center text-center py-4">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">Searching for &quot;{lastQuery}&quot;...</p>
          </div>
        )}
        {error && (
          <Alert variant="destructive" className="mb-4">
            <Terminal className="h-4 w-4" />
            <AlertTitle>Search Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!isLoading && !error && searchResults.length === 0 && lastQuery && (
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground">No results found for &quot;{lastQuery}&quot;.</p>
          </div>
        )}
        {/* Only render SearchResultsList if there are actual results and not in a loading/error state that implies no results yet */}
        {!isLoading && !error && searchResults.length > 0 && (
          <SearchResultsList results={searchResults} onSelect={onResultClick} />
        )}
      </div>
    </aside>
  );
}
