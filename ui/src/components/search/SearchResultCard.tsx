'use client'; // Required for useRouter

import * as React from 'react';
import { useRouter } from 'next/navigation'; // Import useRouter
import { SearchResultItem } from '@/lib/types/search';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * Props for the {@link SearchResultCard} component.
 */
interface SearchResultCardProps {
  /** The search result item data to display. */
  item: SearchResultItem;
  /** Callback when the card is selected. */
  onSelect?: () => void;
}

/**
 * `SearchResultCard` displays a single search result item in a card format.
 * The card is clickable and navigates to a detailed view of the search result.
 * It includes the item's title, category (if available), and a snippet of its description.
 *
 * @param props - The props for the component.
 * @returns A React functional component representing a search result card.
 */
export function SearchResultCard({ item, onSelect }: SearchResultCardProps) {
  const router = useRouter();

  /**
   * Handles the navigation to the full content view of the search result.
   * It constructs query parameters from the item's details (title, description, URL, category)
   * and navigates to `/search/view/{item.id}`.
   */
  const handleViewFullContent = () => {
    const queryParams = new URLSearchParams({
      title: item.title || 'Untitled Document', // Provide a fallback for title
      description: item.description || 'No description available.', // Provide a fallback for description
    });
    if (item.url) {
      queryParams.set('url', item.url);
    }
    if (item.category) {
      queryParams.set('category', item.category);
    }
    // Ensure item.id is present; otherwise, this navigation will fail or be incorrect.
    // Consider adding a check or fallback if item.id could be missing.
    router.push(`/search/view/${item.id}?${queryParams.toString()}`);
    onSelect?.();
  };

  return (
    <Card 
      className="transition-all hover:shadow-md cursor-pointer"
      onClick={handleViewFullContent} // Make the card clickable
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleViewFullContent();}} // Accessibility
      tabIndex={0} // Make it focusable
      role="button" // ARIA role
      aria-label={`View details for ${item.title || 'Untitled'}`}
    >
      <CardHeader className="pb-2 pt-4 px-4">
        {/* Title no longer an external link, but part of the clickable card */}
        <CardTitle className="text-base font-semibold leading-snug">
          {item.title || 'Untitled'}
        </CardTitle>
        {item.category && (
          <div className="mt-1.5">
            <Badge variant="secondary" className="text-xs font-medium">
              {item.category}
            </Badge>
          </div>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-3">
        <CardDescription className="text-sm text-muted-foreground line-clamp-2">
          {item.description}
        </CardDescription>
      </CardContent>
      {/* Footer with explicit "View Source" link is removed as per original comment, 
          the full view page will handle displaying the source URL if available. */}
    </Card>
  );
}
