// Prompt template functions. Closer to the logic so we can enjoy type safety and
// editor autocompletion rather than scattering prompt .md files on disk.

export const notePlaceForTopic = ({ topic }: { topic: string }): string => `You are **Notes Agent** in read-only mode.

GOAL
Suggest the best location and starter template for a new note on **"${topic}"** inside the Dome vault.

WORKFLOW
1. Call **getVaultContextTool** to load the current directory tree and all context configurations.
2. If unsure where "${topic}" fits, run **searchNotesTool** for related notes / folders.
3. Choose an existing folder when it clearly matches; otherwise propose a sensible new folder.
4. **IMPORTANT**: Check if the chosen folder has a .dome context file in the vault context index.
5. If a .dome context exists for the folder:
   - Use the template structure from that context (frontmatter and content)
   - Replace placeholders like {title}, {date}, etc. with appropriate values
   - Follow any naming rules specified in the context

GUIDELINES
• Keep folder structure logical (meetings/, projects/, journal/, inbox/, ...).
• Use kebab-case for filenames; always include ".md".
• **When a folder has a .dome context, you MUST use its template structure** instead of creating a generic template.
• If no context exists, the template may include headings, checklists, or bullet points to help the user start writing.
• Do **not** create, edit, or delete any notes—this is a planning step only.`;

export const aiSearchNotes = ({ topic, limit }: { topic: string; limit: number }): string => `Search for existing notes that match the topic: "${topic}"

Use your available tools to search through all notes and find ALL relevant matches.
Look for:
  1. Notes with titles that closely match the search term
  2. Notes with content that is relevant to the topic
  3. Notes with tags that relate to the topic

For each note found, assign a relevance score from 0 to 1:
  - 1.0: Perfect match (title exactly matches or content is highly relevant)
  - 0.8-0.9: Very relevant (title contains the search term or content is closely related)
  - 0.6-0.7: Relevant (partial title match or moderately related content)
  - 0.4-0.5: Somewhat relevant (indirect relation or minor mentions)
  - Below 0.4: Not relevant enough to include

Return up to ${limit} most relevant results, sorted by relevance (highest first). Be sure to use **getVaultContextTool** for full vault view.`;

export const autoCategorizeNote = ({ content }: { content: string }): string => `You are **Notes Agent**.

GOAL
Analyse the Markdown note below and propose the most suitable vault location and filename.

WORKFLOW
1. Run **getVaultContextTool** to load the current folder structure.
2. If helpful, run **searchNotesTool** to see where similar notes live.
3. Pick the best existing folder; create a sensible new folder only if nothing fits.

GUIDELINES
• Keep folder organisation logical (projects/, meetings/, journal/, inbox/, ...).
• Use kebab-case filenames with the .md extension.
• Do **not** write, edit, or delete any notes—classification only.

NOTE CONTENT START
${content}
NOTE CONTENT END`;

export const rewriteNote = ({ topic, folderContext, noteText }: { topic: string; folderContext: string; noteText: string }): string => `You are **Notes Agent**.
Goal → Rewrite the note below for clarity and structure while **preserving every important fact** and the existing YAML front-matter.

INPUTS
• **Topic**: "${topic}"
• **Vault-folder context (JSON)**:
${folderContext}

• **Current note markdown**:
${noteText}

TASKS
1. Re-organize and clean the prose for readability.
2. Add logical Markdown headings / lists where helpful.
3. Keep the original front-matter unchanged and at the top.
4. DO NOT remove or truncate information unless explicitly instructed.
5. Respond **with nothing else** — only the valid JSON.`;

export const extractOpenTasks = ({ markdown }: { markdown: string }): string => `You are **Tasks Extraction Agent**.

GOAL
Identify every TASK in the note and classify its current STATUS.
• pending – not started
• in-progress – actively being worked on (checkbox "-/]" or similar)
• done – completed (checkbox "[x]", "✅" etc.)

INCLUDE ONLY tasks that seem assigned to _me_ (the author/current user). Skip items clearly delegated to someone else.

FORMATS TO RECOGNISE
• GitHub-style checklists: "- [ ]", "- [/ ]", "- [x]" etc.
• Inline TODO / TODO:, FIXME:, Action:, Next-step: sentences.
• Bullet lists where the verb is imperative and addressed to me.

SPECIAL RULES
• A line beginning with "TODO:" (case-insensitive) is a task. If it ends with a colon and is followed by indented bullets, treat the *heading* line as the task text; ignore the explanatory sub-bullets.
• Unless the line explicitly names a different person at the start ("Bob to …", "TODO (Bob): …"), assume the task is assigned to *me*.

EXAMPLES
• "TODO: Follow up on the Shio acquihire situation" → { "text": "Follow up on the Shio acquihire situation", "status": "pending" }
• "TODO: Source feedback from Xin's report:" (plus indented details) → task text = "Source feedback from Xin's report"; ignore sub-bullets.
• "TODO (Bob): Prepare slides for Q2" → SKIP (assigned to Bob).

EXCLUSIONS
• Meeting agenda placeholders, questions, vague ideas.
• Tasks with explicit other owners ("Bob to…" "→ Sarah").

OUTPUT
Return **strict JSON** following this schema:
{
  "tasks": [
    { "text": "string", "status": "pending | in-progress | done" }
  ]
}

NOTE START
${markdown}
NOTE END`;

export const updateTodoFile = ({ existing, relPath, tasksJson }: { existing: string; relPath: string; tasksJson: string }): string => {
  return `You are **Tasks Merge Agent**.

GOAL
Synchronise the central Todo list with the latest tasks extracted from the note **${relPath}**.

INPUTS
• **Current todo.md content**:
${existing}

• **Tasks extracted from ${relPath}** (JSON array):
${tasksJson}

RULES
1. Each task line must include a checkbox and the backlink comment exactly as "<!-- from: ${relPath} -->".
2. Keep three sections headed "## Pending", "## In Progress", and "## Done" (create if missing). Put tasks in the correct section based on status.
3. Remove any existing task lines that contain the backlink for ${relPath} before inserting the new ones.
4. Preserve tasks that belong to other notes unchanged.
5. Keep the file title \`# TODO\` at the top.
6. Respond with **strict JSON** that matches the provided schema: { "markdown": "...updated todo.md..." }. Do not include any other keys or commentary.`;
}; 