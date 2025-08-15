Search for existing notes that match the topic: "{{topic}}"

Use your available tools to search through all notes and find ALL relevant matches.
Look for:

1. Notes with titles that closely match the search term
2. Notes with content that is relevant to the topic
3. Notes with tags that relate to the topic

For each note found, assign a relevance score from 0 to 1:

- 1.0: Perfect match (title exactly matches or content is highly relevant)
- 0.8 - 0.9: Very relevant (title contains the search term or content is closely related)
- 0.6 - 0.7: Relevant (partial title match or moderately related content)
- 0.4 - 0.5: Somewhat relevant (indirect relation or minor mentions)
- Below 0.4: Not relevant enough to include

Return up to {{limit}} most relevant results, sorted by relevance score (highest first).
Be sure to use the getVaultContext tool to get a full view of the vault structure.
