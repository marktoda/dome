/**
 * Represents a single item returned in a search result list.
 */
export interface SearchResultItem {
  /** Unique identifier for the search result item. */
  id: string;
  /** The main title or heading of the search result. */
  title: string;
  /** A brief description or snippet of the content. */
  description: string;
  /** Optional URL pointing to the full content or source of the item. */
  url?: string;
  /** Optional category or type classification for the search result (e.g., 'Document', 'Issue'). */
  category?: string;
  // Add other relevant fields like relevance score, last modified date, etc. if needed
}

/**
 * Represents the overall structure of a response from the search API.
 */
export interface SearchResponse {
  /** An array of search result items matching the query. */
  results: SearchResultItem[];
  /** The total number of results found (might be different from the length of `results` if paginated). */
  total: number;
  /** The original search query string submitted by the user. */
  query: string;
  // Add pagination info (e.g., page, pageSize, totalPages) if applicable
}

/**
 * Represents the structure of an error response from the search API.
 */
export interface SearchError {
  /** A message describing the error that occurred during the search. */
  message: string;
  /** Optional error code for categorization. */
  code?: string;
}
