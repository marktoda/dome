'use client';

import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { SearchIcon } from 'lucide-react';

/**
 * Defines the Zod schema for the search form.
 * The search query must be a string with a minimum length of 2 characters.
 */
const formSchema = z.object({
  query: z.string().min(2, {
    message: 'Search query must be at least 2 characters.',
  }),
});

/**
 * Type representing the values of the search form, inferred from the Zod schema.
 */
type SearchFormValues = z.infer<typeof formSchema>;

/**
 * Props for the {@link SearchInput} component.
 */
interface SearchInputProps {
  /** Callback function invoked when a search is submitted. Receives the search query string. */
  onSearch: (query: string) => void;
  /** Optional boolean indicating if a search operation is currently in progress. Disables the input and button if true. */
  isLoading?: boolean;
  /** Optional initial value for the search query input field. */
  initialQuery?: string;
}

/**
 * `SearchInput` provides a form with an input field and a submit button for performing searches.
 * It uses `react-hook-form` for form management and `zod` for validation.
 *
 * @param props - The props for the component.
 * @returns A React functional component representing the search input form.
 */
export function SearchInput({ onSearch, isLoading, initialQuery = '' }: SearchInputProps) {
  const form = useForm<SearchFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      query: initialQuery,
    },
  });

  /**
   * Handles the form submission.
   * Invokes the `onSearch` callback with the validated query data.
   * @param data - The validated form data.
   */
  function onSubmit(data: SearchFormValues) {
    onSearch(data.query);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex w-full items-end gap-2"> {/* Changed space-x to gap, removed max-w as sidebar controls width */}
        <FormField
          control={form.control}
          name="query"
          render={({ field }) => (
            <FormItem className="flex-grow">
              <FormLabel className="sr-only">Search Content</FormLabel> {/* Made label screen-reader only as icon and placeholder are clear */}
              <FormControl>
                <div className="relative">
                  <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /> {/* Adjusted icon size */}
                  <Input
                    placeholder="Search knowledge base..."
                    {...field}
                    className="pl-9 h-10 rounded-md focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Search query"
                  />
                </div>
              </FormControl>
              <FormMessage className="mt-1 text-xs" /> {/* Added margin and adjusted text size for form message */}
            </FormItem>
          )}
        />
        <Button type="submit" disabled={isLoading} className="h-10 rounded-md px-4 hover:bg-primary/90 transition-colors"> {/* Adjusted height, padding, added hover effect */}
          {isLoading ? (
            'Searching...'
          ) : (
            <>
              <SearchIcon className="h-4 w-4 md:hidden" /> {/* Icon for mobile */}
              <span className="hidden md:inline">Search</span> {/* Text for desktop */}
            </>
          )}
        </Button>
      </form>
    </Form>
  );
}