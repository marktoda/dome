import { Command } from "commander";
import { indexNotes } from "../../mastra/core/search.js";
import logger from "../utils/logger.js";

export function createIndexCommand(): Command {
  const indexCommand = new Command("index");
  
  indexCommand
    .description("Index all notes for semantic search")
    .action(async () => {
      try {
        logger.info("Starting note indexing for semantic search...");
        await indexNotes('full');
        logger.info("✅ Note indexing completed successfully!");
      } catch (error) {
        logger.error("❌ Error during indexing:", error);
        process.exit(1);
      }
    });

  return indexCommand;
}
