import { diagnosticEffect, type DiagnosticEffect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { compareStrings } from "../../../../src/core/compare";

type SignalEvent = {
  readonly signal: string;
  readonly path: string;
};

type TriggerMatch = {
  readonly matchedSignals: ReadonlyArray<SignalEvent>;
};

type RawImmutableInput = {
  readonly matchedTriggers?: ReadonlyArray<TriggerMatch>;
};

type RawMutation = {
  readonly path: string;
  readonly canSourceRef: boolean;
};

const rawImmutable = defineProcessorImplementation<RawImmutableInput>({
  async run(ctx: ProcessorContext<RawImmutableInput>) {
    const mutations = rawMutations(ctx.input);
    return mutations.map((mutation) => rawMutationDiagnostic(ctx, mutation));
  },
});

function rawMutations(input: RawImmutableInput): ReadonlyArray<RawMutation> {
  const paths = new Map<string, boolean>();
  for (const trigger of input.matchedTriggers ?? []) {
    for (const event of trigger.matchedSignals) {
      if (!isRawPath(event.path)) continue;
      if (event.signal === "file.modified") {
        paths.set(event.path, true);
      } else if (event.signal === "file.deleted" && !paths.has(event.path)) {
        paths.set(event.path, false);
      }
    }
  }
  return Object.freeze(
    [...paths.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([path, canSourceRef]) => Object.freeze({ path, canSourceRef })),
  );
}

function rawMutationDiagnostic(
  ctx: ProcessorContext<RawImmutableInput>,
  mutation: RawMutation,
): DiagnosticEffect {
  return diagnosticEffect({
    severity: "block",
    code: "raw.immutable",
    message:
      `raw/ is immutable; revert the committed mutation to '${mutation.path}' ` +
      "before Dome can adopt this proposal.",
    sourceRefs: mutation.canSourceRef ? [ctx.sourceRef(mutation.path)] : [],
  });
}

function isRawPath(path: string): boolean {
  return path === "raw" || path.startsWith("raw/");
}

export default rawImmutable;
