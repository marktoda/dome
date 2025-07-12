# Semantic Search Setup

This guide covers setting up semantic search for your notes using LanceDB (embedded vector database).

## Prerequisites

✅ **No server required!** LanceDB runs embedded within the application - no separate database server needed.

## Environment Variables

Create a `.env` file or set these environment variables:

```bash
# Required for embeddings
OPENAI_API_KEY=your_openai_api_key_here

# Optional - Notes vault path (defaults to ~/dome)
DOME_VAULT_PATH=/path/to/your/notes

# Optional - Vector database path (defaults to {vault}/.vector_db)
LANCE_DB_PATH=/custom/path/to/vector_db
```

## Usage

1. **Index your notes**:
   ```bash
   dome index
   ```
   This will:
   - Create the embedded vector database in your vault at `.vector_db/`
   - Chunk your markdown files using Mastra's markdown-aware chunking
   - Generate embeddings using OpenAI's text-embedding-3-small
   - Store vectors in LanceDB (embedded, no server needed)

2. **Search your notes**:
   ```bash
   dome
   > "Where did I write about project architecture?"
   > "Find notes about meeting with client"
   > "Show me content related to system design"
   ```

## Troubleshooting

### "Table does not exist" or similar database errors
- Run `dome index` first to create the search index
- Check that the vault directory exists and is writable
- Verify the vector database path is accessible

### "OpenAI API errors"
- Verify OPENAI_API_KEY is set correctly
- Check your OpenAI account has sufficient credits
- Ensure you have access to text-embedding-3-small model

## Features

- **Embedded database**: No separate server required - LanceDB runs in-process
- **Semantic search**: Find notes by meaning, not just keywords
- **Markdown-aware chunking**: Respects document structure
- **Metadata integration**: Includes note paths, tags, and modification dates
- **Batch processing**: Efficient indexing with rate limiting
- **Agent integration**: Works seamlessly with the notes agent
- **Vault-local storage**: Vector database stored inside your notes vault

## Performance

- **Chunk size**: 256 tokens with 20 token overlap
- **Embedding model**: text-embedding-3-small (1536 dimensions)
- **Batch size**: 5 files at a time during indexing
- **Search results**: Default 6 results per query
- **Database**: LanceDB embedded - fast, efficient, zero-config