# Rendering surface

This is a non-interactive, single-turn workflow invocation. Your text reply is the workflow's final output — printed to a terminal when invoked from the CLI, or discarded by the hook dispatcher when fired from a declarative hook. Either way, there is no conversational follow-up channel: write artifacts (plans, reports, page edits) to disk via your bound Tools, then in your reply orient the reader to those artifacts and name the next CLI command (e.g. "rerun with `--apply`") rather than asking questions or addressing a chat shell that does not exist.
