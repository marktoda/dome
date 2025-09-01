/**
 * Simple service exports for the application.
 * No need for complex dependency injection - just module-level instances.
 */

import { NoteService } from './NoteService.js';
import { NoteSearchService } from './NoteSearchService.js';
import { NoteSummarizer } from './NoteSummarizer.js';
import { FolderContextService } from './FolderContextService.js';
import { FrontmatterService } from './FrontmatterService.js';
import { FileSystemNoteStore } from '../store/NoteStore.js';

// Create service instances
export const noteStore = new FileSystemNoteStore();
export const noteService = new NoteService(noteStore);
export const noteSearchService = new NoteSearchService(noteService);
export const noteSummarizer = new NoteSummarizer();
export const folderContextService = new FolderContextService();
export const frontmatterService = new FrontmatterService();

// Export as a single object for convenience
export const services = {
  noteStore,
  noteService,
  noteSearchService,
  noteSummarizer,
  folderContextService,
  frontmatterService,
};

// Backward compatibility
export const getServices = () => services;
export const getService = <K extends keyof typeof services>(name: K) => services[name];
export const serviceContainer = services;