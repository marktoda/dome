import * as React from 'react';
import { SearchResultItem } from '@/lib/types/search';
import { SearchResultCard } from './SearchResultCard';

/**
 * Props for the {@link SearchResultsList} component.
 */
interface SearchResultsListProps {
  /** An array of search result items to display. */
  results: SearchResultItem[];
  /** Callback when a result is selected. */
  onSelect?: () => void;
}

/**
 * `SearchResultsList` renders a list of {@link SearchResultCard} components.
 * If no results are provided, it renders nothing (null), as the parent component
 * is expected to handle the "no results" message or loading states.
 *
 * @param props - The props for the component.
 * @returns A React functional component displaying a list of search results, or null if results are empty.
 */
export function SearchResultsList({ results, onSelect }: SearchResultsListProps) {
  // The parent component (e.g., a page or a more complex search UI container)
  // is responsible for showing "no results" messages or loading indicators.
  // This component's sole responsibility is to render the list if results exist.
  if (results.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3"> {/* Reduced spacing for a tighter list in the sidebar */}
      {results.map((item) => (
        <SearchResultCard key={item.id} item={item} onSelect={onSelect} />
      ))}
    </div>
  );
}
