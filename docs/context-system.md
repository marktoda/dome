# Dome Context System

The Dome Context System allows you to configure how notes behave in different folders of your vault. Each folder can have its own `.dome` configuration file that defines templates, naming rules, required fields, and AI behavior.

## Quick Start

1. **Check which folders need contexts:**
   ```bash
   dome setup
   ```

2. **Create a context for a folder:**
   ```bash
   dome context create meetings --template meetings
   ```

3. **List all contexts:**
   ```bash
   dome context list
   ```

## What is a Context?

A context is a configuration file (`.dome`) placed in a folder that defines:
- **Templates**: Default content and frontmatter for new notes
- **Naming Rules**: How files should be named (e.g., `YYYY-MM-DD-{title}`)
- **Required Fields**: Frontmatter fields that must be present
- **Auto Tags**: Tags automatically added to notes in this folder
- **AI Instructions**: Custom behavior for the AI assistant when working in this folder

## Available Templates

Dome comes with several pre-configured templates:

### Meetings (`meetings`)
For 1-1s, team meetings, and discussions
- Auto-names files with date prefix
- Tracks attendees, action items, and decisions
- Template includes agenda and discussion sections

### Daily Journal (`journal`)
For personal reflections and daily logs
- One file per day (YYYY-MM-DD format)
- Tracks mood, highlights, challenges, and gratitude
- Private and personal focus

### Projects (`projects`)
For project planning and documentation
- Tracks status, timeline, and stakeholders
- Includes goals, tasks, and progress sections
- Links related resources

### Ideas (`ideas`)
For brainstorming and creative thoughts
- Quick capture format
- Tracks inspiration and potential
- Minimal required fields

### Reading Notes (`reading`)
For books, articles, and research
- Tracks author, source type, and ratings
- Includes summary and key takeaways sections
- Action items from readings

## Creating Contexts

### Using a Template
```bash
dome context create <folder> --template <template-name>
```

Example:
```bash
dome context create meetings --template meetings
dome context create projects/webapp --template projects
```

### Custom Context
```bash
dome context create <folder> --name "Custom Name" --description "What this folder is for"
```

## Context Inheritance

Contexts are hierarchical - subfolders inherit settings from parent folders:

```
vault/
├── .dome (root context - applies to all notes)
├── projects/
│   ├── .dome (projects context - applies to all projects)
│   └── webapp/
│       └── notes.md (inherits from projects context)
└── meetings/
    ├── .dome (meetings context)
    └── 2023-12-01-standup.md (uses meetings context)
```

## .dome File Format

Context files use YAML format:

```yaml
---
name: "Meeting Notes"
description: "Notes from team meetings and 1-1s"
template:
  frontmatter:
    attendees: []
    action_items: []
    decisions: []
  content: |
    # Meeting: {title}
    Date: {date}
    
    ## Agenda
    
    ## Discussion
    
    ## Action Items
rules:
  fileNaming: "YYYY-MM-DD-{title}"
  requiredFields: ["attendees"]
  autoTags: ["meeting"]
---
When working with meeting notes:
- Extract action items and assign owners
- Summarize key decisions
- Identify follow-up topics
```

## File Naming Patterns

Available placeholders for `fileNaming` rules:
- `YYYY` - Four-digit year
- `MM` - Two-digit month
- `DD` - Two-digit day
- `{title}` - Note title (lowercase, spaces replaced with hyphens)
- `{date}` - ISO date (YYYY-MM-DD)
- `{time}` - Time (HHmmss)
- `{uuid}` - Random unique identifier

Examples:
- `YYYY-MM-DD-{title}` → `2023-12-01-team-standup.md`
- `{title}` → `project-overview.md`
- `{date}-meeting` → `2023-12-01-meeting.md`

## Context-Aware Features

### 1. Note Creation
When you create a note in a folder with a context, Dome automatically:
- Applies the template
- Uses the file naming pattern
- Adds required frontmatter fields
- Includes auto-tags

### 2. Note Validation
Check if a note follows its context rules:
```bash
dome context validate path/to/note.md
```

### 3. AI Assistant
The AI assistant adapts its behavior based on the context's `aiInstructions`. For example:
- In meeting folders: Focuses on extracting action items
- In journal folders: Maintains privacy and focuses on reflection
- In project folders: Tracks progress and milestones

### 4. Context-Aware Search
Search within specific contexts:
```python
# Search only in meeting notes
dome> search "budget discussion" in meetings/

# Search in project and all sub-projects
dome> search "deployment" in projects/
```

## Best Practices

1. **Start with Templates**: Use the built-in templates as a starting point
2. **Keep It Simple**: Don't over-configure; add rules as you need them
3. **Use Inheritance**: Put common settings in parent folders
4. **Document AI Behavior**: Clear `aiInstructions` help the AI work better
5. **Regular Validation**: Periodically validate notes against their contexts

## Examples

### Research Project Setup
```bash
# Create project structure
mkdir -p research/papers research/notes research/data

# Set up contexts
dome context create research --template projects
dome context create research/papers --template reading
dome context create research/notes --name "Research Notes" \
  --description "Quick notes and observations during research"
```

### Personal Knowledge Base
```bash
# Create structure
mkdir -p kb/tech kb/business kb/personal

# Root context for all knowledge base notes
dome context create kb --name "Knowledge Base" \
  --description "Personal knowledge management system"

# Specific contexts for each area
dome context create kb/tech --template ideas
dome context create kb/business --template projects
dome context create kb/personal --template journal
```

## Troubleshooting

### Context Not Applied
- Check if the `.dome` file exists in the folder
- Validate the YAML syntax in the `.dome` file
- Ensure the context has a `name` and `description`

### File Naming Issues
- Verify the pattern uses valid placeholders
- Check if the pattern includes `.md` extension (it's added automatically)
- Ensure date formats are uppercase (YYYY, not yyyy)

### Validation Errors
- Run `dome context validate` to see specific issues
- Check if required fields are present in frontmatter
- Verify tags include both manual and auto-tags

## Advanced Usage

### Dynamic Templates
Use placeholders in templates that get replaced when creating notes:
- `{title}` - The note title
- `{date}` - Current date
- `{time}` - Current time
- `{attendees}` - From frontmatter

### Multiple Contexts
While each folder can only have one `.dome` file, you can:
1. Use inheritance from parent folders
2. Create sub-folders with different contexts
3. Override parent settings in child contexts

### Context Migration
To apply a context to existing notes:
1. Create the context configuration
2. Use `dome reorganize` to update notes
3. Validate with `dome context validate`