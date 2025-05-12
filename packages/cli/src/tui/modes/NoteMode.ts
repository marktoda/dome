import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';
import { execSync as cpExecSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Note mode for creating and editing notes
 */
export class NoteMode extends BaseMode {
  private isEditing: boolean = false;
  private searchResults: (DomeApi.Note | DomeApi.SearchResultItem)[] = [];
  private searchQuery: string = '';
  private selectedNoteIndex: number = -1;
  private viewMode: 'create' | 'search' | 'view' = 'create';
  private currentViewedNote: DomeApi.Note | null = null;


  constructor() {
    super({
      id: 'note',
      name: 'Note',
      description: 'Create and edit notes',
      shortcut: 'C-n',
      color: 'yellow',
    });
  }

  protected onInit(): void {
    // Nothing to initialize
  }

  protected onActivate(): void {
    this.container.setLabel(' Note Mode ');
    this.showMainMenu();
  }

  protected onDeactivate(): void {
    this.resetState();
  }

  private resetState(): void {
    this.isEditing = false;
    this.searchResults = [];
    this.searchQuery = '';
    this.selectedNoteIndex = -1;
    this.currentViewedNote = null;
    this.viewMode = 'create';
  }

  private showMainMenu(): void {
    this.currentViewedNote = null; 
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Note Mode{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('What would you like to do?');
    this.container.pushLine('');
    this.container.pushLine('  {bold}create{/bold} - Create a new note');
    this.container.pushLine('  {bold}search{/bold} - Search existing notes');
    this.container.pushLine('  {bold}list{/bold}   - List recent notes');
    this.container.pushLine('');
    this.container.pushLine('{gray-fg}Type one of the commands above to continue{/gray-fg}');
    this.screen.render();
  }

  private getEditor(): string {
    return process.env.EDITOR || 'nvim';
  }

  private createTempFileWithMetadata(title?: string, existingContent?: string, existingCategory?: string, existingTagsString?: string): string {
    const tempFilePath = path.join(os.tmpdir(), `dome-note-${Date.now()}.md`);
    const date = new Date().toISOString();

    const metadata = [
      `# ${title || 'New Note'}`,
      `Date: ${date}`,
      `Category: ${existingCategory || ''}`, 
      `Tags: ${existingTagsString || ''}`, 
      '',
      '<!-- Write your note content below this line -->',
      '',
      existingContent || '',
    ].join('\n');

    fs.writeFileSync(tempFilePath, metadata);
    return tempFilePath;
  }

  private openEditor(filePath: string): Promise<void> {
    this.isEditing = true;
    this.container.setContent('');
    this.container.pushLine('{center}{bold}External Editor{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('Opening external editor...');
    this.container.pushLine('');
    this.container.pushLine(`Editor: ${this.getEditor()}`);
    this.container.pushLine(`File: ${filePath}`);
    this.container.pushLine('');
    this.container.pushLine('{gray-fg}The TUI will resume when you exit the editor{/gray-fg}');
    this.screen.render();

    return new Promise((resolve, reject) => {
      try {
        const originalStdin = process.stdin.isRaw;
        this.screen.program.normalBuffer();
        this.screen.program.clear();

        try {
          cpExecSync(`${this.getEditor()} "${filePath}"`, {
            stdio: 'inherit',
            env: process.env,
          });
          process.nextTick(() => {
            this.screen.program.alternateBuffer();
            if (originalStdin) process.stdin.setRawMode(true);
            this.screen.program.clear();
            this.screen.program.cursorReset();
            this.screen.realloc();
            this.screen.render();
            this.isEditing = false;
            resolve();
          });
        } catch (error) {
          process.nextTick(() => {
            this.screen.program.alternateBuffer();
            if (originalStdin) process.stdin.setRawMode(true);
            this.screen.program.clear();
            this.screen.program.cursorReset();
            this.screen.realloc();
            this.screen.render();
            this.isEditing = false;
            const errorMessageText = error instanceof Error ? error.message : String(error);
            reject(new Error(`Editor exited with error: ${errorMessageText}`));
          });
        }
      } catch (err) {
        this.isEditing = false;
        reject(err);
      }
    });
  }

  private parseNoteContent(filePath: string): {
    title: string;
    content: string;
    tags: string[]; 
    category: string; 
    summary?: string;
  } {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    let title = 'Untitled Note';
    let tags: string[] = [];
    let category = '';
    let summary: string | undefined = undefined;
    let contentStartIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (i === 0 && line.startsWith('# ')) {
        title = line.substring(2).trim();
        continue;
      }
      if (line.startsWith('Category:')) {
        category = line.substring(9).trim();
        continue;
      }
      if (line.startsWith('Tags:')) {
        const tagsPart = line.substring(5).trim();
        if (tagsPart) tags = tagsPart.split(',').map(tag => tag.trim());
        continue;
      }
      if (line.startsWith('Summary:')) {
        summary = line.substring(8).trim();
        continue;
      }
      if (line.includes('<!-- Write your note content below this line -->')) {
        contentStartIndex = i + 2; 
        break;
      }
      if (i >= 10) { 
        contentStartIndex = i; 
        break;
      }
    }
    const contentBody = lines.slice(contentStartIndex).join('\n').trim();
    return { title, content: contentBody, tags, category, summary };
  }

  private async createNewNote(): Promise<void> {
    try {
      const tempFilePath = this.createTempFileWithMetadata();
      await this.openEditor(tempFilePath);
      const { title, content, tags, category } = this.parseNoteContent(tempFilePath);

      if (!content.trim()) {
        this.container.setContent('');
        this.container.pushLine('{yellow-fg}Note was empty, nothing saved.{/yellow-fg}');
        this.container.pushLine('');
        this.container.pushLine('Press any key to return to the main menu.');
        this.screen.render();
        return;
      }

      this.statusBar.setContent(' {bold}Status:{/bold} Saving note...');
      this.screen.render();

      const apiClient = getApiClient();

      // Assuming DomeApi.IngestNoteBodyApiSchemaCategory is an enum.
      // We get its string values for validation.
      // This part might need adjustment if the enum structure is different,
      // or if it's a union of string literals (in which case the original error is odd).
      const validCategoryStrings: string[] = Object.values(DomeApi.IngestNoteBodyApiSchemaCategory || {});
      let finalCategory: DomeApi.IngestNoteBodyApiSchemaCategory | undefined = undefined;
      
      const parsedCategoryString = category; // from parseNoteContent
      const firstTag = tags.length > 0 ? tags[0] : undefined;

      if (parsedCategoryString && validCategoryStrings.includes(parsedCategoryString)) {
        finalCategory = parsedCategoryString as DomeApi.IngestNoteBodyApiSchemaCategory;
      } else if (firstTag && validCategoryStrings.includes(firstTag)) {
        finalCategory = firstTag as DomeApi.IngestNoteBodyApiSchemaCategory;
      } else if (tags.length > 0) {
        const foundTagCategory = tags.find(t => validCategoryStrings.includes(t));
        if (foundTagCategory) {
          finalCategory = foundTagCategory as DomeApi.IngestNoteBodyApiSchemaCategory;
        }
      }
      // If no valid category found, it remains undefined. Or, set a default:
      // if (!finalCategory && validCategoryStrings.includes("general")) {
      //   finalCategory = "general" as DomeApi.IngestNoteBodyApiSchemaCategory;
      // }
      
      const noteToIngest: DomeApi.IngestNoteBodyApiSchema = {
        content,
        title,
        category: finalCategory,
      };
      // customMetadata field was confirmed not to exist on IngestNoteBodyApiSchema.
      // If cliTags (from the parsed `tags` array) need to be stored,
      // they must be part of the note's content string or a separate mechanism if the API supports it.
      // For now, only the `finalCategory` (derived from parsed `category` or first valid tag) is used.

      const response: DomeApi.Note = await apiClient.notes.ingestANewNote(noteToIngest);
      try { fs.unlinkSync(tempFilePath); } catch (errUnlink) { /* ignore */ }

      this.container.setContent('');
      this.container.pushLine('{center}{bold}Note Saved{/bold}{/center}');
      this.container.pushLine('');
      this.container.pushLine(`{green-fg}Your note "${response.title || title}" has been saved successfully!{/green-fg}`);
      this.container.pushLine(`{bold}ID:{/bold} ${response.id}`);
      this.container.pushLine(`{bold}Category:{/bold} ${response.category || '(none)'}`);
      this.container.pushLine(`{bold}MIME Type:{/bold} ${response.mimeType}`);
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
      this.screen.render();
    } catch (err: unknown) {
      let errorMessageText = 'Error creating note.';
      if (err instanceof DomeApiError) { const apiError = err as DomeApiError; errorMessageText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
      else if (err instanceof DomeApiTimeoutError) { const timeoutError = err as DomeApiTimeoutError; errorMessageText = `API Timeout Error: ${timeoutError.message}`; }
      else if (err instanceof Error) { errorMessageText = `Error creating note: ${err.message}`; }
      this.container.setContent('');
      this.container.pushLine(`{red-fg}${errorMessageText}{/red-fg}`);
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
      this.screen.render();
    }
  }

  private showSearchPrompt(): void {
    this.viewMode = 'search';
    this.currentViewedNote = null;
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Search Notes{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('Enter search query:');
    if (this.searchQuery) this.container.pushLine(`Current: ${this.searchQuery}`);
    this.container.pushLine('');
    this.container.pushLine('{gray-fg}(Type {bold}menu{/bold} to return to the main menu){/gray-fg}');
    this.screen.render();
  }

  private async searchNotes(query: string): Promise<void> {
    try {
      this.searchQuery = query;
      this.statusBar.setContent(' {bold}Status:{/bold} Searching notes...');
      this.screen.render();

      const apiClient = getApiClient();
      const searchRequest: DomeApi.GetSearchRequest = { q: query, limit: 20 };
      const response: DomeApi.SearchResponse = await apiClient.search.searchContent(searchRequest);
      
      this.searchResults = response.success ? (response.results || []) : [];
      this.showSearchResults();
    } catch (err: unknown) {
      let errorMessageText = 'Error searching notes.';
      if (err instanceof DomeApiError) { const apiError = err as DomeApiError; errorMessageText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
      else if (err instanceof DomeApiTimeoutError) { const timeoutError = err as DomeApiTimeoutError; errorMessageText = `API Timeout Error: ${timeoutError.message}`; }
      else if (err instanceof Error) { errorMessageText = `Error searching notes: ${err.message}`; }
      this.container.setContent('');
      this.container.pushLine(`{red-fg}${errorMessageText}{/red-fg}`);
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
      this.screen.render();
    }
  }

  private showSearchResults(): void {
    this.currentViewedNote = null;
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Search Results{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine(`Query: "${this.searchQuery}"`);
    this.container.pushLine('');

    if (this.searchResults.length === 0) {
      this.container.pushLine('{yellow-fg}No results found.{/yellow-fg}');
    } else {
      this.container.pushLine(`Found ${this.searchResults.length} results:`);
      this.container.pushLine('');
      (this.searchResults as DomeApi.SearchResultItem[]).forEach((resultItem: DomeApi.SearchResultItem, index: number) => {
        const title = resultItem.title || 'Untitled Note';
        const date = resultItem.createdAt ? new Date(resultItem.createdAt).toLocaleString() : 'Unknown date';
        // Ensure score is a number before calling toFixed
        const score = typeof resultItem.score === 'number' ? resultItem.score.toFixed(2) : 'N/A';
        this.container.pushLine(`{bold}${index + 1}.{/bold} ${title} (Score: ${score})`);
        this.container.pushLine(`   {gray-fg}ID: ${resultItem.id} | Category: ${resultItem.category} | Created: ${date}{/gray-fg}`);
        if (resultItem.summary) {
          this.container.pushLine(`   {gray-fg}Summary: ${resultItem.summary.substring(0, 80)}${resultItem.summary.length > 80 ? '...' : ''}{/gray-fg}`);
        }
      });
      this.container.pushLine('');
      this.container.pushLine('Enter the number of the note to view/edit, or:');
    }
    this.container.pushLine('{gray-fg}Type {bold}search{/bold} to search again or {bold}menu{/bold} to return to the main menu{/gray-fg}');
    this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
    this.screen.render();
  }

  private async listRecentNotes(): Promise<void> {
    try {
      this.statusBar.setContent(' {bold}Status:{/bold} Loading recent notes...');
      this.screen.render();

      const apiClient = getApiClient();
      const notesListed: DomeApi.Note[] = await apiClient.notes.listNotes({ limit: 20 }); 
      this.searchResults = notesListed || []; 
      this.viewMode = 'search'; 
      this.currentViewedNote = null;

      this.container.setContent('');
      this.container.pushLine('{center}{bold}Recent Notes{/bold}{/center}');
      this.container.pushLine('');

      if (this.searchResults.length === 0) {
        this.container.pushLine('{yellow-fg}No notes found.{/yellow-fg}');
      } else {
        this.container.pushLine(`Displaying ${this.searchResults.length} recent notes:`);
        this.container.pushLine('');
        (this.searchResults as DomeApi.Note[]).forEach((noteItem: DomeApi.Note, index: number) => {
          const title = noteItem.title || 'Untitled Note';
          const date = noteItem.createdAt ? new Date(noteItem.createdAt).toLocaleString() : 'Unknown date';
          this.container.pushLine(`{bold}${index + 1}.{/bold} ${title} (ID: ${noteItem.id})`);
          this.container.pushLine(`   {gray-fg}Category: ${noteItem.category || '(none)'} | Created: ${date}{/gray-fg}`);
          if (noteItem.content) {
             this.container.pushLine(`   {gray-fg}${noteItem.content.substring(0, 80)}${noteItem.content.length > 80 ? '...' : ''}{/gray-fg}`);
          }
        });
        this.container.pushLine('');
        this.container.pushLine('Enter the number of the note to view/edit, or:');
      }
      this.container.pushLine('{gray-fg}Type {bold}menu{/bold} to return to the main menu{/gray-fg}');
      this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
      this.screen.render();
    } catch (err: unknown) {
      let errorMessageText = 'Error listing notes.';
      if (err instanceof DomeApiError) { const apiError = err as DomeApiError; errorMessageText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
      else if (err instanceof DomeApiTimeoutError) { const timeoutError = err as DomeApiTimeoutError; errorMessageText = `API Timeout Error: ${timeoutError.message}`; }
      else if (err instanceof Error) { errorMessageText = `Error listing notes: ${err.message}`; }
      this.container.setContent('');
      this.container.pushLine(`{red-fg}${errorMessageText}{/red-fg}`);
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
      this.screen.render();
    }
  }

  private async viewAndEditNote(index: number): Promise<void> {
    try {
      if (index < 0 || index >= this.searchResults.length) {
        this.container.pushLine('{red-fg}Invalid note number.{/red-fg}');
        this.screen.render();
        return;
      }

      const itemSummary = this.searchResults[index] as (DomeApi.SearchResultItem | DomeApi.Note);
      if (!itemSummary || !itemSummary.id) {
        this.container.pushLine('{red-fg}Error: Selected item has no ID.{/red-fg}');
        this.screen.render();
        return;
      }
      this.selectedNoteIndex = index; 

      this.statusBar.setContent(' {bold}Status:{/bold} Loading note details...');
      this.screen.render();
      
      let noteToView: DomeApi.Note;
      try {
        const apiClient = getApiClient();
        noteToView = await apiClient.notes.getANoteById(itemSummary.id);
        this.currentViewedNote = noteToView; 
      } catch (fetchErr: unknown) {
        let errMessage = 'Error fetching note details.';
        if (fetchErr instanceof DomeApiError) { const apiError = fetchErr as DomeApiError; errMessage = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
        else if (fetchErr instanceof DomeApiTimeoutError) { const timeoutError = fetchErr as DomeApiTimeoutError; errMessage = `API Timeout Error: ${timeoutError.message}`; }
        else if (fetchErr instanceof Error) { errMessage = `Error fetching note details: ${fetchErr.message}`; }
        this.container.pushLine(`{red-fg}${errMessage}{/red-fg}`);
        this.screen.render();
        return;
      }
      
      this.viewMode = 'view'; 
      this.container.setContent('');
      this.container.pushLine(`{center}{bold}View Note: ${noteToView.title || 'Untitled'}{/bold}{/center}`);
      this.container.pushLine('');
      this.container.pushLine(`{bold}ID:{/bold} ${noteToView.id}`);
      this.container.pushLine(`{bold}Title:{/bold} ${noteToView.title || 'Untitled'}`);
      this.container.pushLine(`{bold}Category:{/bold} ${noteToView.category || '(none)'}`);
      this.container.pushLine(`{bold}MIME Type:{/bold} ${noteToView.mimeType}`);
      this.container.pushLine(`{bold}Created:{/bold} ${new Date(noteToView.createdAt).toLocaleString()}`);
      if (noteToView.customMetadata?.cliTags) { 
         const tags = Array.isArray(noteToView.customMetadata.cliTags) ? noteToView.customMetadata.cliTags.join(', ') : String(noteToView.customMetadata.cliTags);
         this.container.pushLine(`{bold}Tags (custom):{/bold} ${tags}`);
      }

      this.container.pushLine('');
      this.container.pushLine('{bold}Content:{/bold}');
      this.container.pushLine(noteToView.content || '(No content)');
      this.container.pushLine('');
      this.container.pushLine('{gray-fg}Type {bold}edit{/bold} to edit, {bold}delete{/bold} to delete, or {bold}menu{/bold} to return.{/gray-fg}');
      this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | Viewing Note (ID: ${noteToView.id})`);
      this.screen.render();

    } catch (err: unknown) {
      let errorMessageText = 'Error processing note view.';
       if (err instanceof DomeApiError) { const apiError = err as DomeApiError; errorMessageText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
      else if (err instanceof DomeApiTimeoutError) { const timeoutError = err as DomeApiTimeoutError; errorMessageText = `API Timeout Error: ${timeoutError.message}`; }
      else if (err instanceof Error) { errorMessageText = `Error processing note view: ${err.message}`; }
      this.container.pushLine(`{red-fg}${errorMessageText}{/red-fg}`);
      this.screen.render();
    }
  }

  async handleInput(input: string): Promise<void> {
    if (this.isEditing) return; 

    const trimmedInput = input.trim();
    const lowerInput = trimmedInput.toLowerCase();

    try {
      switch (this.viewMode) {
        case 'create':
          if (lowerInput === 'create') {
            process.nextTick(async () => {
              try { await this.createNewNote(); } catch (errCatch: unknown) { this.container.pushLine(`{red-fg}Error: ${errCatch instanceof Error ? errCatch.message : String(errCatch)}{/red-fg}`); this.screen.render(); }
            });
          } else if (lowerInput === 'search') {
            this.showSearchPrompt();
          } else if (lowerInput === 'list') {
            process.nextTick(async () => {
              try { await this.listRecentNotes(); } catch (errCatch: unknown) { this.container.pushLine(`{red-fg}Error: ${errCatch instanceof Error ? errCatch.message : String(errCatch)}{/red-fg}`); this.screen.render(); }
            });
          } else if (lowerInput === 'menu') {
             this.showMainMenu();
          }
          break;

        case 'search':
          if (lowerInput === 'search') {
            this.showSearchPrompt();
          } else if (this.searchResults.length > 0) {
            const noteNumber = parseInt(trimmedInput, 10);
            if (!isNaN(noteNumber) && noteNumber > 0 && noteNumber <= this.searchResults.length) {
              this.statusBar.setContent(' {bold}Status:{/bold} Loading note...');
              this.screen.render();
              process.nextTick(async () => {
                try { await this.viewAndEditNote(noteNumber - 1); } catch (errCatch: unknown) { this.container.pushLine(`{red-fg}Error: ${errCatch instanceof Error ? errCatch.message : String(errCatch)}{/red-fg}`); this.screen.render(); }
              });
            } else if (trimmedInput && lowerInput !== 'menu') { 
                 this.statusBar.setContent(' {bold}Status:{/bold} Searching...');
                 this.screen.render();
                 process.nextTick(async () => {
                    try { await this.searchNotes(trimmedInput); } catch (errCatch: unknown) { this.container.pushLine(`{red-fg}Error: ${errCatch instanceof Error ? errCatch.message : String(errCatch)}{/red-fg}`); this.screen.render(); }
                 });
            } else if (lowerInput === 'menu') {
                this.resetState();
                this.showMainMenu();
            }
          } else if (trimmedInput && lowerInput !== 'menu') { 
             this.statusBar.setContent(' {bold}Status:{/bold} Searching...');
             this.screen.render();
             process.nextTick(async () => {
                try { await this.searchNotes(trimmedInput); } catch (errCatch: unknown) { this.container.pushLine(`{red-fg}Error: ${errCatch instanceof Error ? errCatch.message : String(errCatch)}{/red-fg}`); this.screen.render(); }
             });
          } else if (lowerInput === 'menu') {
            this.resetState();
            this.showMainMenu();
          }
          break;

        case 'view': {
          const noteToActOn = this.currentViewedNote; 

          if (!noteToActOn || !noteToActOn.id) {
            this.container.pushLine('{red-fg}Error: No note selected or note ID is missing.{/red-fg}');
            this.showMainMenu();
            break;
          }

          if (lowerInput === 'edit') {
            process.nextTick(async () => {
              try {
                const tempFilePath = this.createTempFileWithMetadata(
                    noteToActOn.title, 
                    noteToActOn.content, 
                    noteToActOn.category, 
                    noteToActOn.customMetadata?.cliTags ? 
                        (Array.isArray(noteToActOn.customMetadata.cliTags) ? noteToActOn.customMetadata.cliTags.join(', ') : String(noteToActOn.customMetadata.cliTags)) 
                        : ''
                );
                
                await this.openEditor(tempFilePath);
                const updatedNoteParsed = this.parseNoteContent(tempFilePath);
                fs.unlinkSync(tempFilePath);

                this.statusBar.setContent(' {bold}Status:{/bold} Processing edited note...');
                this.screen.render();
                
                this.container.setContent('');
                this.container.pushLine('{center}{bold}Note Edited (Locally Parsed){/bold}{/center}');
                this.container.pushLine(`{yellow-fg}Update/Save functionality via SDK is pending.{/yellow-fg}`);
                this.container.pushLine(`{yellow-fg}To save changes, manually delete original (ID: ${noteToActOn.id}) and create new.{/yellow-fg}`);
                this.container.pushLine(`{bold}Original ID:{/bold} ${noteToActOn.id}`);
                this.container.pushLine(`{bold}Parsed Title:{/bold} ${updatedNoteParsed.title}`);
                this.container.pushLine(`{bold}Parsed Category:{/bold} ${updatedNoteParsed.category}`);
                this.container.pushLine(`{bold}Parsed Tags:{/bold} ${updatedNoteParsed.tags.join(', ')}`);
                this.container.pushLine(`{bold}Parsed Content Snippet:{/bold} ${(updatedNoteParsed.content || '').substring(0, 50)}...`);
                this.container.pushLine('');
                this.container.pushLine('Type {bold}menu{/bold} to return.');
                this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | Note processed locally`);
                this.screen.render();
              } catch (editErr: unknown) {
                let errMsgText = "Error during edit process.";
                if (editErr instanceof DomeApiError) { const apiError = editErr as DomeApiError; errMsgText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
                else if (editErr instanceof DomeApiTimeoutError) { const timeoutError = editErr as DomeApiTimeoutError; errMsgText = `API Timeout: ${timeoutError.message}`; }
                else if (editErr instanceof Error) { errMsgText = `Error during edit process: ${editErr.message}`; }
                this.container.pushLine(`{red-fg}${errMsgText}{/red-fg}`);
                this.screen.render();
              }
            });
          } else if (lowerInput === 'delete') {
            this.statusBar.setContent(' {bold}Status:{/bold} Deleting note...');
            this.screen.render();
            process.nextTick(async () => {
              try {
                const apiClient = getApiClient();
                await apiClient.notes.deleteANote(noteToActOn.id); 
                this.container.setContent('');
                this.container.pushLine('{center}{bold}Note Deleted{/bold}{/center}');
                this.container.pushLine('');
                this.container.pushLine(`{green-fg}Note "${noteToActOn.title || noteToActOn.id}" has been deleted.{/green-fg}`);
                this.searchResults = this.searchResults.filter(n => n.id !== noteToActOn.id);
                this.selectedNoteIndex = -1;
                this.currentViewedNote = null;
                this.viewMode = 'search'; 
                this.showSearchResults(); 
              } catch (deleteErr: unknown) {
                let errMsgText = "Failed to delete note.";
                if (deleteErr instanceof DomeApiError) { const apiError = deleteErr as DomeApiError; errMsgText = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`; }
                else if (deleteErr instanceof DomeApiTimeoutError) { const timeoutError = deleteErr as DomeApiTimeoutError; errMsgText = `API Timeout: ${timeoutError.message}`; }
                else if (deleteErr instanceof Error) { errMsgText = `Failed to delete note: ${deleteErr.message}`; }
                this.container.pushLine(`{red-fg}${errMsgText}{/red-fg}`);
              } finally {
                 this.statusBar.setContent(` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`);
                 this.screen.render();
              }
            });
          } else if (lowerInput === 'menu') {
            this.resetState();
            this.showMainMenu();
          }
          break;
        }
      }
    } catch (err: unknown) { 
      let errorMessageText = 'Error in Note Mode input handler.';
      if (err instanceof Error) {
        errorMessageText = `Error in Note Mode input handler: ${err.message}`;
      }
      this.container.pushLine(`{red-fg}${errorMessageText}{/red-fg}`);
      this.screen.render();
    }
  }

  getHelpText(): string {
    return `
{bold}Note Mode Help{/bold}

In Note Mode, you can create and edit notes using your preferred text editor.

{bold}Commands:{/bold}
- {bold}create{/bold} - Create a new note in your editor
- {bold}search{/bold} [query] - Search for existing notes
- {bold}list{/bold}   - List recent notes
- {bold}menu{/bold}   - Return to the main menu

When viewing search results or a list:
- Enter a {bold}number{/bold} to view/edit that note.

When viewing a single note:
- {bold}edit{/bold}   - Edit the current note
- {bold}delete{/bold} - Delete the current note
- {bold}menu{/bold}   - Return to the main menu / previous view

{bold}Editor:{/bold}
The note mode uses your $EDITOR environment variable (defaults to nvim).

{bold}Shortcuts:{/bold}
- {cyan-fg}${this.config.shortcut}{/cyan-fg} - Switch to Note Mode
`;
  }
}
