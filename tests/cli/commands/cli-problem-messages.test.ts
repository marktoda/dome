// Byte-identity coverage for cliProblemMessages — the CLI stderr expansion
// relocated from the retired runStructuredViewCommand. The multi-line
// processor-failed output and the no-structured-result override are the
// trickiest preserved wording, so they are pinned directly here rather than
// only through a live-vault path.

import { describe, expect, test } from "bun:test";

import { cliProblemMessages } from "../../../src/cli/structured-view-command";
import { diagnosticEffect } from "../../../src/core/effect";
import { FIRST_PARTY_VIEWS } from "../../../src/surface/view-catalog";

const LABEL = "dome query";
const ENTRY = FIRST_PARTY_VIEWS.query;
const NO_RESULT = "dome query: query processor returned no structured result.";

describe("cliProblemMessages", () => {
  test("no-structured-result uses the per-caller override verbatim", () => {
    const messages = cliProblemMessages(
      LABEL,
      ENTRY,
      { kind: "no-structured-result" },
      NO_RESULT,
    );
    expect(messages).toEqual([NO_RESULT]);
  });

  test("processor-failed expands the operator line + execution error + each diagnostic, in order", () => {
    const messages = cliProblemMessages(
      LABEL,
      ENTRY,
      {
        kind: "processor-failed",
        processorId: "dome.search/query",
        executionStatus: "error",
        executionError: { code: "boom", message: "kaboom" },
        diagnostics: [
          diagnosticEffect({
            severity: "error",
            code: "d1",
            message: "first",
            sourceRefs: [],
          }),
          diagnosticEffect({
            severity: "warning",
            code: "d2",
            message: "second",
            sourceRefs: [],
          }),
        ],
      },
      NO_RESULT,
    );
    expect(messages).toEqual([
      "dome query: processor 'dome.search/query' finished with error.",
      "dome query: boom: kaboom",
      "dome query: diagnostic [error] d1: first",
      "dome query: diagnostic [warning] d2: second",
    ]);
  });

  test("processor-failed with no execution error and no diagnostics is the single operator line", () => {
    const messages = cliProblemMessages(
      LABEL,
      ENTRY,
      {
        kind: "processor-failed",
        processorId: "dome.search/query",
        executionStatus: "timeout",
        executionError: null,
        diagnostics: [],
      },
      NO_RESULT,
    );
    expect(messages).toEqual([
      "dome query: processor 'dome.search/query' finished with timeout.",
    ]);
  });

  test("invalid-payload renders the single shared operator line", () => {
    const messages = cliProblemMessages(
      LABEL,
      ENTRY,
      { kind: "invalid-payload", issues: "text: Required" },
      NO_RESULT,
    );
    expect(messages).toEqual([
      "dome query: query processor returned a payload that failed validation (text: Required).",
    ]);
  });
});
