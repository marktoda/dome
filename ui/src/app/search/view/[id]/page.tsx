'use client';

export const runtime = 'edge';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation'; // useSearchParams removed as we fetch by ID
import { Button } from '@/components/ui/button';
import { ArrowLeftIcon, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
// SearchResultItem might not be directly needed if Note type covers all fields
// import { SearchResultItem } from '@/lib/types/search';
import { notesApi, Note } from '../../../../lib/api'; // Adjusted path

interface SearchResultViewPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// Using any as a temporary workaround for the persistent PageProps constraint issue
const SearchResultViewPage: React.FC<SearchResultViewPageProps> = ({ params }) => {
  const router = useRouter();
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { id: noteId } = React.use(params);

  useEffect(() => {
    if (noteId) {
      setLoading(true);
      setError(null);
      notesApi.getNoteById(noteId)
        .then(data => {
          // The 'data' here is now the 'note' object directly, thanks to the updated notesApi.getNoteById
          console.log("Fetched note data from API:", JSON.stringify(data, null, 2));
          setNote(data);
          setLoading(false);
        })
        .catch(err => {
          console.error("Failed to fetch note:", err);
          setError(err.response?.data?.error || err.message || 'Failed to load note content.');
          setLoading(false);
        });
    } else {
      setError("No note ID provided.");
      setLoading(false);
    }
  }, [noteId]);

  // 1. Verify State Update: Log the state variable `note` when it changes
  useEffect(() => {
    if (note) {
      console.log("Note state updated:", JSON.stringify(note, null, 2));
    }
  }, [note]);

  if (loading) {
    return (
      <div className="container mx-auto p-4 flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
        <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
        <p className="text-lg text-muted-foreground">Loading note content...</p>
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="container mx-auto p-4">
        <Button onClick={() => router.back()} variant="outline" className="mb-4">
          <ArrowLeftIcon className="mr-2 h-4 w-4" /> Back to Search
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Error Loading Note</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{error || 'The note content could not be loaded. It might have been moved or an error occurred.'}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const displayTitle = note.title || 'Note Detail';

  // 2. Inspect Conditional Rendering Logic & 4. Data Access
  // 3. Check Loading State Interaction: This logic runs after loading is false and note is available.
  let displayContent: string;
  if (note.body !== null && note.body !== undefined) {
    // note.body exists, prioritize it
    if (note.body.trim() === '') {
      displayContent = "Note body is present but empty."; // Explicit message for empty body
    } else {
      displayContent = note.body;
    }
  } else if (note.summary && note.summary.trim() !== '') {
    // note.body is absent, fallback to note.summary if it has content
    displayContent = note.summary;
  } else {
    // Both note.body and note.summary are absent or effectively empty
    displayContent = 'No content available.';
  }

  return (
    <div className="container mx-auto p-4 md:p-6 lg:p-8">
      <Button onClick={() => router.back()} variant="outline" className="mb-6 inline-flex items-center">
        <ArrowLeftIcon className="mr-2 h-5 w-5" />
        Back to Search Results
      </Button>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-2xl lg:text-3xl">{displayTitle}</CardTitle>
          {note.category && (
            <CardDescription className="text-md pt-1">
              Category: <span className="font-semibold">{note.category}</span>
            </CardDescription>
          )}
          {note.customMetadata?.tags && Array.isArray(note.customMetadata.tags) && note.customMetadata.tags.length > 0 && (
            <CardDescription className="text-md pt-1">
              Tags: {note.customMetadata.tags.join(', ')}
            </CardDescription>
          )}
          {/* Displaying other relevant custom metadata */}
          {note.customMetadata?.repository && (
            <CardDescription className="text-sm pt-1">
              Repository: <a href={`https://github.com/${note.customMetadata.repository}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">{note.customMetadata.repository}</a>
            </CardDescription>
          )}
          {note.customMetadata?.path && (
            <CardDescription className="text-sm pt-1">
              File Path: {note.customMetadata.path}
            </CardDescription>
          )}
          {note.customMetadata?.commitMessage && (
            <CardDescription className="text-sm pt-1">
              Commit: {note.customMetadata.commitMessage}
            </CardDescription>
          )}
          {note.customMetadata?.author && (
            <CardDescription className="text-sm pt-1">
              Author: {note.customMetadata.author}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="prose max-w-none dark:prose-invert whitespace-pre-wrap">
            {displayContent}
          </div>
        </CardContent>
        {note.customMetadata?.htmlUrl && (
          <CardFooter className="flex justify-end pt-4">
            <Button asChild variant="link">
              <a href={note.customMetadata.htmlUrl} target="_blank" rel="noopener noreferrer">
                View Source
              </a>
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
};

export default SearchResultViewPage;
