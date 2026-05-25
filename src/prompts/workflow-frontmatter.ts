import { z } from "zod";
import { ok, err, type Result } from "../types";

// The 7 canonical tool names from sdk-surface.md §"Tool signatures".
const TOOL_NAMES = [
  "readDocument",
  "writeDocument",
  "appendLog",
  "searchIndex",
  "wikilinkResolve",
  "moveDocument",
  "deleteDocument",
] as const;

const ToolNameSchema = z.enum(TOOL_NAMES);

export const WorkflowFrontmatterSchema = z.object({
  type: z.literal("workflow-prompt"),
  name: z.string().min(1),
  tools: z.array(ToolNameSchema).min(0),
  triggers: z.array(z.string()),
  description: z.string().optional(),
});

export type WorkflowFrontmatter = z.infer<typeof WorkflowFrontmatterSchema>;

export function parseWorkflowFrontmatter(
  raw: unknown
): Result<WorkflowFrontmatter, { kind: "validation"; message: string }> {
  const parsed = WorkflowFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ kind: "validation", message: parsed.error.message });
  }
  return ok(parsed.data);
}

export function isWorkflowPrompt(fm: unknown): boolean {
  if (!fm || typeof fm !== "object") return false;
  return (fm as Record<string, unknown>).type === "workflow-prompt";
}
