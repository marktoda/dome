import { Command } from "commander";
import { indexNotes } from "../../mastra/core/search-indexer.js";

export function createIndexCommand(): Command {
  const indexCommand = new Command("index");
  
  indexCommand
    .description("Index all notes for semantic search")
    .action(async () => {
      try {
        console.log("Starting note indexing for semantic search...");
        await indexNotes();
        console.log("✅ Note indexing completed successfully!");
      } catch (error) {
        console.error("❌ Error during indexing:", error);
        process.exit(1);
      }
    });

  return indexCommand;
}