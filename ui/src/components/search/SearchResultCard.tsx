'use client'; // Required for useRouter

import * as React from 'react';
import { useRouter } from 'next/navigation'; // Import useRouter
import { SearchResultItem } from '@/lib/types/search';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
// ExternalLink might not be needed if we navigate internally first
// import { ExternalLink } from 'lucide-react'; 

interface SearchResultCardProps {
  item: SearchResultItem;
}

export function SearchResultCard({ item }: SearchResultCardProps) {
  const router = useRouter();

  const handleViewFullContent = () => {
    const queryParams = new URLSearchParams({
      title: item.title || '',
      description: item.description || '',
    });
    if (item.url) {
      queryParams.set('url', item.url);
    }
    if (item.category) {
      queryParams.set('category', item.category);
    }
    router.push(`/search/view/${item.id}?${queryParams.toString()}`);
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
