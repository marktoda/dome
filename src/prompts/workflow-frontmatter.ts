import { z } from "zod";
import { ok, err, type Result } from "../types";
// The seven canonical Tool names — derived from the single source-of-truth
// registry. Adding a Tool there automatically extends what's valid in
// workflow-prompt frontmatter `tools:` lists.
import { TOOL_NAMES } from "../tools/registry";

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
