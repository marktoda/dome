// Shared formatting/classification for user-facing question resolution hints.

import type {
  QuestionAutomationPolicy,
  QuestionMetadata,
} from "./core/effect";

export function resolveQuestionCommand(input: {
  readonly id: number | string | null | undefined;
  readonly options: ReadonlyArray<string> | null | undefined;
}): string {
  const id = input.id === null || input.id === undefined
    ? "<question-id>"
    : String(input.id);
  return `dome resolve ${id} ${questionValuePlaceholder(input.options)}`;
}

export function questionValuePlaceholder(
  options: ReadonlyArray<string> | null | undefined,
): string {
  if (options === null || options === undefined || options.length === 0) {
    return "<answer>";
  }
  return `<${options.join("|")}>`;
}

export function questionResolutionDescription(
  options: ReadonlyArray<string> | null | undefined,
): string {
  if (options === null || options === undefined || options.length === 0) {
    return "Resolve an open Dome decision by providing an answer.";
  }
  return "Resolve an open Dome decision using one of the listed options.";
}

export function questionAutomationPolicy(
  metadata: QuestionMetadata | null | undefined,
): QuestionAutomationPolicy {
  return metadata?.automationPolicy ?? "owner-needed";
}

export function isQuestionAgentResolvable(
  metadata: QuestionMetadata | null | undefined,
): boolean {
  const policy = questionAutomationPolicy(metadata);
  return policy === "agent-safe" || policy === "model-safe";
}

export function questionAutomationLabel(
  metadata: QuestionMetadata | null | undefined,
): string {
  const policy = questionAutomationPolicy(metadata);
  const risk = metadata?.risk ?? "unknown";
  const confidence = metadata?.confidence === undefined
    ? "unknown"
    : metadata.confidence.toFixed(2);
  return `${policy}; risk ${risk}; confidence ${confidence}`;
}
