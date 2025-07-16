System Vision
Dome will become a unified personal exobrain that:

Maintains human-readable markdown notes as the source of truth
Provides intelligent, context-aware note organization and retrieval
Supports multiple interfaces (CLI, Web, Telegram, APIs)
Enables seamless capture of thoughts from any context
Learns and adapts to individual note-taking patterns

Architecture Principles

Human-First Storage: All data stored as readable markdown files
Modular Design: Each component can be developed and deployed independently
Context-Aware: System understands different note types and contexts
Extensible: Plugin architecture for custom workflows and integrations
Local-First: Core functionality works offline with optional sync

Project 1: Context System Implementation
Overview
Implement a folder-based context system where each folder can contain a .dome configuration file that defines how notes in that context should be handled.
Technical Specification
1.1 Context Configuration Schema
typescript// src/types/context.ts
interface DomeContext {
name: string;
description: string;
template?: {
frontmatter?: Record<string, any>;
content?: string;
};
rules?: {
fileNaming?: string; // e.g., "YYYY-MM-DD-{title}"
requiredFields?: string[];
autoTags?: string[];
};
aiInstructions?: string; // Instructions for AI when working with notes in this context
}
1.2 Context Manager
typescript// src/mastra/core/context-manager.ts
class ContextManager {
async loadContext(folderPath: string): Promise<DomeContext | null>
async findContextForPath(notePath: string): Promise<DomeContext | null>
async createContext(folderPath: string, context: DomeContext): Promise<void>
async validateNoteAgainstContext(notePath: string, content: string): Promise<ValidationResult>
}
1.3 Default Contexts
Create starter .dome files for common use cases:
meetings/.dome
yamlname: "Meeting Notes"
description: "Notes from 1-1s, team meetings, and discussions"
template:
frontmatter:
attendees: []
action_items: []
decisions: []
content: | # Meeting: {title}
Date: {date}
Attendees: {attendees}

    ## Agenda

    ## Discussion

    ## Action Items

    ## Decisions

rules:
fileNaming: "YYYY-MM-DD-{meeting-name}"
requiredFields: ["attendees"]
aiInstructions: |
When creating meeting notes:

- Extract action items and assign owners
- Summarize key decisions
- Identify follow-up topics
  Implementation Tasks

Create Context Types and Schema (2 days)

Define TypeScript interfaces
Create Zod schemas for validation
Write unit tests for type validation

Implement Context Manager (3 days)

File system operations for .dome files
Context inheritance (child folders inherit parent context)
Caching layer for performance

Interactive Setup Wizard (4 days)

dome setup command with interactive prompts
Folder structure scanner and suggestions
Preset context templates (meetings, journal, projects, etc.)
AI-powered custom context generation
Preview and edit before saving

Setup Wizard Flow
typescript// Example interaction flow
dome setup

> Scanning your vault structure...
> Found 5 folders without context files:
>
> 1. meetings/
> 2. projects/
> 3. daily/
> 4. ideas/
> 5. reading/
>
> Select a folder to configure: meetings/
> Choose an option:
>
> 1. Use preset template
> 2. Describe folder purpose (AI will generate context)
> 3. Create from scratch
> 4. Skip this folder
>
> [If option 2 selected]
> Describe what you use this folder for: "I store all my 1-1 meeting notes here,
> usually with action items and follow-ups"
>
> Generating context configuration...
> [Shows generated .dome file]
> Accept this configuration? (y/n/edit)

Integrate with Existing Tools (3 days)

Update writeNoteTool to respect context rules
Add context awareness to search operations
Modify agent prompts based on context

CLI Commands (2 days)

dome setup - Interactive setup wizard
dome context create <folder> - Create single context
dome context list - Show all contexts
dome context validate <path> - Validate notes against context

Testing Requirements

Unit tests for context loading and validation
Integration tests for context-aware note creation
Performance tests for context resolution in large vaults
