// @dome/sdk/workflows — the LLM-driven surface.
//
// This entrypoint carries the @anthropic-ai/sdk + ai (Vercel AI SDK) deps.
// Consumers that don't drive LLM-based workflows import from @dome/sdk
// (core) instead — see docs/wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.md.

export { runWorkflow, buildAiSdkTools, DEFAULT_MODEL, DEFAULT_MAX_STEPS } from "./agent-loop";
export type { RunWorkflowOpts, RunWorkflowResult } from "./agent-loop";

export { WorkflowName, WORKFLOW_NAMES, isWorkflowName } from "./workflow-name";
export { WorkflowTier, WORKFLOW_TIERS } from "./workflow-tier";

export { projectAiSdk } from "./project-ai-sdk";

// Re-exported from src/prompts/ — workflows entrypoint hosts the prompt
// registry + loader because both are workflow-runner inputs.
export { PromptLoader, PromptSource } from "../prompts/prompt-loader";
export type { LoadedPrompt } from "../prompts/prompt-loader";
export { WorkflowRegistry } from "../prompts/registry";
export type { WorkflowDefinition } from "../prompts/registry";
export {
  parseWorkflowFrontmatter,
  isWorkflowPrompt,
  WorkflowFrontmatterSchema,
} from "../prompts/workflow-frontmatter";
export type { WorkflowFrontmatter } from "../prompts/workflow-frontmatter";

// Eval suite — workflow-runner consumers (tests, future replay tooling) use
// the fixture-vault helper to spin up isolated test vaults.
export { makeFixtureVault } from "../eval/fixture-vault";
export type { Fixture, EvalFixtureVault } from "../eval/fixture-vault";
