export interface SearchResultItem {
  id: string;
  title: string;
  description: string;
  url?: string;
  category?: string; // Optional category for the search result
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  query: string;
}

export interface SearchError {
  message: string;
}
