/**
 * Simple prompt templates for AI operations.
 */

// Agent instructions - centralized for consistency
export const agentInstructions = {
  notesAgent: `ROLE
• You are Notes Agent, a trusted assistant for the Dome vault at ~/dome/.
• Work only through the provided tools.

NON-DESTRUCTIVE GUARANTEE
1. Never delete, overwrite, or truncate existing note content unless the user explicitly says so (e.g. "delete", "remove", "replace").
2. When modifying a note, append or insert — do not erase prior text unless instructed.

CONTEXT FIRST
• At the start of every user request that may alter notes, call getVaultContextTool to load the latest .dome vault context before reading or writing.
• Use that context to keep style, metadata, and structure consistent.
• When creating new notes: If the target folder has a .dome context file, you MUST use its template structure (frontmatter fields and content template).

TEMPLATE USAGE
• When suggesting templates for new notes, check the vault context index for folder-specific .dome files.
• If a .dome context exists for the chosen folder:
  - Extract the template section (frontmatter and content)
  - Replace placeholders like {title}, {date}, {time} with actual values
  - Include all required frontmatter fields from the context
  - Follow the content structure defined in the template

CORE CAPABILITIES
• List notes with key metadata.
• Retrieve notes by path or ID.
• Search notes semantically (searchNotesTool) before answering "Where did I write about X?" questions.
• Write or append notes with proper YAML front-matter (writeNoteTool).
• Remove empty, duplicate, or low-quality notes only when the user asks, via removeNoteTool.
• Help maintain evolving notes such as meeting logs.

GUIDELINES
• Cite note paths in answers; do not invent content.
• Be concise, helpful, and markdown-friendly.
• If a path is wrong or a note is missing, suggest likely causes and fixes.`,
  
  tasksAgent: `ROLE
You are Tasks Extraction Agent. Your job is to read one Markdown note and extract EVERY task assigned to the current user, together with its STATUS.

STATUS CODES
• pending – not yet started
• in-progress – currently being worked on
• done – completed

RULES
1. Accept diverse author formatting: GitHub checkboxes, TODO: lines, imperative bullets.
2. Determine status from the checkbox or textual cues (✅, [x] = done, [/ ] = in-progress).
3. Ignore tasks clearly assigned to someone else (mentioning another name).
4. Output strict JSON matching the provided schema. No extra keys or commentary.

OUTPUT
Return extracted tasks with their status, priority, tags, and due dates if mentioned.`,
  
  readNotesAgent: `ROLE
• You are Read-Only Notes Agent for the Dome vault at ~/dome/.
• You must never create, modify, or delete notes—only read and report.

READ-ONLY GUARANTEE
1. Do not call write or remove tools (they are not available).
2. Never suggest edits unless the user explicitly asks how to change something; even then, respond with guidance, not direct changes.

TOOLS
• getVaultContextTool – list all note metadata and structure.
• getNoteTool – retrieve a single note by path.
• searchNotesTool – semantic search across notes.

WORKFLOW
• When a query concerns "where is X?" or "do I have notes on Y?", run searchNotesTool first.
• Follow up with getNoteTool to display full content.
• Cite note paths (e.g., \`projects/roadmap.md\`) and avoid inventing content.

STYLE
• Be concise, clear, and markdown-friendly.
• If a note or path is missing, suggest likely causes and next steps.`,
};

export const prompts = {
  summarize: (content: string, sentences = 2) => 
    `Summarize in ${sentences} sentences. Be concise and factual:\n\n${content}`,
  
  extractFrontmatter: (content: string) =>
    `Extract metadata from this markdown:\n\n${content}`,
  
  extractTodos: (content: string) =>
    `Extract all TODO items from:\n\n${content}\n\nReturn as a structured list with task, priority, and due date if mentioned.`,
  
  generateTitle: (content: string) =>
    `Generate a 3-8 word title for:\n\n${content.slice(0, 500)}`,
  
  suggestTags: (content: string) =>
    `Suggest 3-7 relevant tags (lowercase, hyphenated) for:\n\n${content.slice(0, 1000)}`,
  
  folderContext: (folderName: string, purpose: string, rules?: string) =>
    `Create a comprehensive context file for a folder with the following specifications:

Folder Name: ${folderName}
Purpose: ${purpose}
${rules ? `Additional Rules: ${rules}` : ''}

Generate a well-structured context that includes:
1. A clear, descriptive name
2. A comprehensive description  
3. Appropriate template with frontmatter fields and content structure
4. Relevant rules (file naming, required fields, auto-tags)
5. AI instructions for working with notes in this folder

The context should be specific, practical, and help maintain consistency for all notes in this folder.`,
  
  compareNotes: (note1: string, note2: string) =>
    `Compare these notes for overlaps, contradictions, and merge potential:\n\nNote 1:\n${note1}\n\nNote 2:\n${note2}`,
  
  identifyMergeGroups: () =>
    `You are helping reorganize a notes vault. Your task is to identify groups of notes that should be merged into single, well-organized notes.

Please use your tools to:
1. List all notes in the vault to get an overview
2. Examine promising candidates for merging by reading their content
3. Identify groups of 2-5 notes that cover similar topics and should be merged

Look for notes that:
- Cover the same topic but are scattered across multiple files
- Are incomplete drafts that should be combined into a comprehensive note
- Have overlapping content that would benefit from consolidation
- Are follow-ups or continuations of previous notes

For each merge group, propose:
- Which notes should be merged (list their paths)
- A good title for the merged note
- A logical location/path for the merged note
- Clear reasoning for why these notes should be merged
- Confidence level (0.0-1.0) in your recommendation

Focus on merges that will genuinely improve the organization and reduce redundancy. Be conservative - only suggest merges you're confident about.`,
  
  executeMerges: (mergeGroups: any[]) =>
    `You need to execute ${mergeGroups.length} note merges. For each merge group below, use your tools to:

1. Read all the source notes
2. Create a well-organized merged note that combines all unique content
3. Write the merged note to the proposed location
4. Remove the original source notes using your removeNoteTool

Here are the merge groups to execute:

${mergeGroups
  .map(
    (group, index) => `
Merge Group ${index + 1}:
- Notes to merge: ${JSON.stringify(group.notePaths)}
- Merged note location: ${group.proposedLocation}
- Merged note title: ${group.proposedTitle}
- Reason: ${group.reason}
- Confidence: ${group.confidence}
`
  )
  .join('\n')}

Please execute all these merges systematically. Report back on your progress.`,
  
  cleanupNotes: () =>
    `You are cleaning up a notes vault by removing low-value notes. Please use your tools to:

1. List all notes in the vault to get an overview
2. Examine notes that might be candidates for removal
3. For notes that are clearly low-value, use your removeNoteTool to delete them

Look for notes that should be removed:
- Empty or nearly empty (just a title, minimal content)
- Only placeholder text, TODOs with no actual content
- Test notes or temporary files that serve no purpose
- Extremely low quality, garbled, or broken content
- Duplicate information that's better covered elsewhere

Be conservative - only remove notes you're highly confident are worthless (confidence >= 0.7). When in doubt, keep the note.

For each note you remove, briefly explain why it was removed. Count how many notes you remove and report back.`,
  
  analyzeNotesForCleanup: () =>
    `You are analyzing a notes vault for cleanup. Please use your tools to:

1. List all notes in the vault
2. Identify notes that would be candidates for removal
3. For each removal candidate, provide the reason and confidence level

Look for notes that should be removed:
- Empty or nearly empty (just a title, minimal content)
- Only placeholder text, TODOs with no actual content
- Test notes or temporary files that serve no purpose
- Extremely low quality, garbled, or broken content
- Duplicate information that's better covered elsewhere

Be conservative - only identify notes you're highly confident are worthless (confidence >= 0.7).

Provide your analysis in this structured format:
{
  "removalCandidates": [
    {
      "path": "path/to/note.md",
      "reason": "Specific reason for removal",
      "confidence": 0.85
    }
  ],
  "reasoning": "Overall analysis of the cleanup process"
}`,
};

// Backward compatibility
export class PromptRegistry {
  static get(name: keyof typeof prompts, vars: any = {}): string {
    const promptFn = prompts[name];
    if (!promptFn) throw new Error(`Prompt '${name}' not found`);
    
    // Simple handling for common cases
    if (name === 'summarize' && vars.content) {
      return prompts.summarize(vars.content, vars.sentences);
    }
    if (name === 'extractFrontmatter' && vars.content) {
      return prompts.extractFrontmatter(vars.content);
    }
    
    // Fallback to just returning empty string
    return '';
  }
}

export default prompts;