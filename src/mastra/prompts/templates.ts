// Prompt template functions. Closer to the logic so we can enjoy type safety and
// editor autocompletion rather than scattering prompt .md files on disk.

export const autoCategorizeNote = ({
  content,
}: {
  content: string;
}): string => `You are **Notes Agent**.

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

export const rewriteNote = ({
  topic,
  folderContext,
  noteText,
}: {
  topic: string;
  folderContext: string;
  noteText: string;
}): string => `You are **Notes Agent**.
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
5. **CRITICAL**: Preserve ALL task-related markers and formatting:
   - Keep "TODO:", "FIXME:", "Action:", etc. prefixes exactly as written
   - Preserve checkbox syntax (- [ ], - [x], - [/]) without modification
   - Maintain imperative/action-oriented language in tasks
   - Keep task context and assignee information (e.g., "TODO (Bob):")
6. Respond **with nothing else** — only the valid JSON.`;

export const extractOpenTasks = ({
  markdown,
}: {
  markdown: string;
}): string => `You are **Tasks Extraction Agent**.

GOAL
Extract ALL actionable tasks from the note and accurately classify their current STATUS.

STATUS DEFINITIONS
• **pending** – not started (empty checkbox "[ ]", "TODO:", or action item without completion marker)
• **in-progress** – actively being worked on (partial checkbox "[/]", "[-]", "IN PROGRESS:", "WIP:")
• **done** – completed (checked "[x]", "[X]", "✅", "DONE:", strikethrough text)

WHAT TO INCLUDE
✓ Tasks clearly assigned to the note author (me/current user)
✓ Action items in any format that represent work to be done
✓ Items with imperative verbs directed at the reader

FORMATS TO RECOGNIZE
1. **Checkbox Lists**
   - \`- [ ] Task\` → pending
   - \`- [/] Task\` or \`- [-] Task\` → in-progress
   - \`- [x] Task\` or \`- [X] Task\` → done
   
2. **Keyword Prefixes** (case-insensitive)
   - \`TODO: Task\` → pending
   - \`FIXME: Issue\` → pending
   - \`ACTION: Task\` → pending
   - \`NEXT: Task\` → pending
   - \`WIP: Task\` or \`IN PROGRESS: Task\` → in-progress
   - \`DONE: Task\` or \`COMPLETED: Task\` → done
   
3. **Bullet Lists with Action Verbs**
   - \`- Review the proposal\` → pending (if no completion marker)
   - \`- Call John about project\` → pending
   - \`* Send email to team\` → pending

SPECIAL RULES
1. **Heading-style TODOs**: If a line starts with "TODO:" and ends with a colon, followed by indented items:
   - Use the heading line as the task text
   - Ignore the indented explanatory bullets below it
   - Example: "TODO: Review Q4 budget:" → task = "Review Q4 budget"

2. **Assignee Detection**: 
   - Default: assume task is for me (the note author)
   - Skip if explicitly assigned to others: "TODO (Bob):", "Sarah to...", "→ John"
   - Include if assigned to me: "TODO (me):", "I need to..."

3. **Context Preservation**:
   - Include enough context to make the task actionable
   - "Fix bug" → "Fix bug in payment processing" (if context available)

WHAT TO EXCLUDE
✗ Questions without action ("What about X?")
✗ Meeting agenda items that are just topics
✗ Completed items in narrative text
✗ Hypothetical actions ("We could...")
✗ Tasks explicitly assigned to others

EXAMPLES
• "TODO: Follow up on the Shio acquisition" → { "text": "Follow up on the Shio acquisition", "status": "pending" }
• "- [/] Reviewing architecture docs" → { "text": "Reviewing architecture docs", "status": "in-progress" }
• "DONE: Submitted expense report" → { "text": "Submitted expense report", "status": "done" }
• "Bob to prepare slides" → SKIP (assigned to Bob)
• "What's the status?" → SKIP (question, not task)

OUTPUT
Return **strict JSON** with this exact schema:
{
  "tasks": [
    { "text": "string", "status": "pending | in-progress | done" }
  ]
}

NOTE START
${markdown}
NOTE END`;

export const updateTodoFile = ({
  existing,
  relPath,
  tasksJson,
}: {
  existing: string;
  relPath: string;
  tasksJson: string;
}): string => {
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

export const updateTodoLists = ({
  existingListsJson,
  relPath,
  noteTasksJson,
}: {
  existingListsJson: string;
  relPath: string;
  noteTasksJson: string;
}): string => `You are **Tasks Merge Agent v2**.

GOAL
Update the central task *lists* – not the markdown – for note **${relPath}**.

INPUTS
• Current lists JSON (all tasks in the todo file):
${existingListsJson}

• Tasks extracted from ${relPath} (JSON array):
${noteTasksJson}

RULES
1. Every task object has shape { "text": string, "from": string }.
2. Remove any task whose "from" equals "${relPath}" from all three arrays.
3. Insert every task from the new extraction into the correct array (pending → pending[], etc.).
4. Preserve tasks belonging to other notes untouched.
5. The arrays MUST remain de-duplicated (no identical {text, from}).

Respond with **strict JSON**:
{
  "pending":   [{"text": "...", "from": "..."}],
  "inProgress": [{...}],
  "done":       [{...}]
}`;
