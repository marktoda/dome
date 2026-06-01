// Shared formatting for user-facing question resolution hints.

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
