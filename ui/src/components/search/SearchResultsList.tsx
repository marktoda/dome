import * as React from 'react';
import { SearchResultItem } from '@/lib/types/search';
import { SearchResultCard } from './SearchResultCard';

interface SearchResultsListProps {
  results: SearchResultItem[];
}

export function SearchResultsList({ results }: SearchResultsListProps) {
  // The parent component (Sidebar.tsx) now handles the "no results" message based on query state.
  // This component should only render the list if there are results.
  if (results.length === 0) {
    return null; // Return null if there are no results to display
  }

  return (
    <div className="space-y-3"> {/* Reduced spacing for a tighter list in the sidebar */}
      {results.map((item) => (
        <SearchResultCard key={item.id} item={item} />
      ))}
    </div>
  );
}