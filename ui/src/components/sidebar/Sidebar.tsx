import React, { useState } from 'react';
import { SearchInput } from '@/components/search/SearchInput';
import { SearchResultsList } from '@/components/search/SearchResultsList';
import { searchApi } from '@/lib/api';
import { SearchResultItem } from '@/lib/types/search';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Terminal } from 'lucide-react';

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<string>('');

  const handleSearch = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setError(null);
      setLastQuery('');
      return;
    }
    setIsLoading(true);
    setError(null);
    setLastQuery(query);
    try {
      const response = await searchApi.search(query);
      setSearchResults(response.results);
    } catch (err) {
      console.error('Search API error:', err);
      setError('Failed to fetch search results. Please try again.');
      setSearchResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <aside className={`h-full w-96 flex-col border-r bg-background p-4 md:p-5 ${className} flex flex-col`}>
      <div className="mb-5"> {/* Increased bottom margin */}
        <h2 className="text-xl font-semibold tracking-tight">Search</h2> {/* Enhanced title styling */}
      </div>
      <SearchInput onSearch={handleSearch} isLoading={isLoading} />
      
      <div className="mt-5 flex-grow overflow-y-auto pr-1"> {/* Increased top margin, added small padding to right for scrollbar */}
        {error && (
          <Alert variant="destructive" className="mb-4">
            <Terminal className="h-4 w-4" />
            <AlertTitle>Search Error</AlertTitle> {/* More specific title */}
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!isLoading && !error && searchResults.length === 0 && lastQuery && (
          <div className="text-center py-4"> {/* Centered no results message */}
            <p className="text-sm text-muted-foreground">No results found for "{lastQuery}".</p>
          </div>
        )}
        <SearchResultsList results={searchResults} />
      </div>

      {/* Future navigation items can go here */}
      {/* <nav className="mt-auto pt-4 border-t">
        <ul>
          Example Navigation Item
           <li className="mb-2">
            <a href="#" className="text-muted-foreground hover:text-foreground">
              Dashboard
            </a>
          </li>
        </ul>
      </nav> */}
    </aside>
  );
}
