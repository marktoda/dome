/**
 * Pagination utilities for handling large data sets
 */

/**
 * Pagination options
 */
export interface PaginationOptions {
  /** Maximum number of items per page */
  limit: number;
  /** Current page number (1-based) */
  page: number;
}

/**
 * Pagination result
 */
export interface PaginationResult<T> {
  /** Items for the current page */
  items: T[];
  /** Pagination metadata */
  pagination: {
    /** Total number of items */
    totalItems: number;
    /** Total number of pages */
    totalPages: number;
    /** Current page number */
    currentPage: number;
    /** Number of items per page */
    pageSize: number;
    /** Whether there is a next page */
    hasNextPage: boolean;
    /** Whether there is a previous page */
    hasPreviousPage: boolean;
  };
}

/**
 * Default pagination options
 */
export const DEFAULT_PAGINATION_OPTIONS: PaginationOptions = {
  limit: 100,
  page: 1
};

/**
 * Maximum allowed page size
 */
export const MAX_PAGE_SIZE = 1000;

/**
 * Validates and normalizes pagination options
 * @param options User-provided pagination options
 * @returns Normalized pagination options
 */
export function normalizePaginationOptions(options?: Partial<PaginationOptions>): PaginationOptions {
  const normalizedOptions: PaginationOptions = {
    limit: options?.limit || DEFAULT_PAGINATION_OPTIONS.limit,
    page: options?.page || DEFAULT_PAGINATION_OPTIONS.page
  };

  // Ensure limit is within bounds
  normalizedOptions.limit = Math.min(
    Math.max(1, normalizedOptions.limit),
    MAX_PAGE_SIZE
  );

  // Ensure page is at least 1
  normalizedOptions.page = Math.max(1, normalizedOptions.page);

  return normalizedOptions;
}

/**
 * Paginates an array of items
 * @param items Array of items to paginate
 * @param options Pagination options
 * @returns Paginated result
 */
export function paginateArray<T>(items: T[], options?: Partial<PaginationOptions>): PaginationResult<T> {
  const { limit, page } = normalizePaginationOptions(options);
  
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / limit);
  const currentPage = Math.min(page, Math.max(1, totalPages));
  
  const startIndex = (currentPage - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalItems);
  
  const paginatedItems = items.slice(startIndex, endIndex);
  
  return {
    items: paginatedItems,
    pagination: {
      totalItems,
      totalPages,
      currentPage,
      pageSize: limit,
      hasNextPage: currentPage < totalPages,
      hasPreviousPage: currentPage > 1
    }
  };
}

/**
 * Processes a large array in batches to avoid memory issues
 * @param items Array of items to process
 * @param batchSize Size of each batch
 * @param processBatch Function to process each batch
 * @returns Promise that resolves when all batches are processed
 */
export async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  processBatch: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];
  
  // Process empty array case
  if (items.length === 0) {
    return results;
  }
  
  // Normalize batch size
  const normalizedBatchSize = Math.max(1, batchSize);
  
  // Process in batches
  for (let i = 0; i < items.length; i += normalizedBatchSize) {
    const batch = items.slice(i, i + normalizedBatchSize);
    // Process the batch
    const batchResults = await processBatch(batch);
    results.push(...batchResults);
  }
  
  return results;
}