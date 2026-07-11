// surface/run-view: the protocol-neutral arbitrary plugin-view operation.
//
// A plugin contributes a command-triggered view processor. This collector is
// the one place that checks discovery, invokes Vault.runView, drains streaming
// content, and turns ViewEffects into a JSON-safe document. Agent, HTTP, and
// MCP adapters only translate their transport around this operation.

import type { DiagnosticEffect } from "../core/effect";
import type { SourceRef } from "../core/source-ref";
import type { Vault } from "../vault";

export const VIEW_RUN_SCHEMA = "dome.view-run/v1";

export type RenderedPluginView =
  | {
      readonly name: string;
      readonly kind: "markdown";
      readonly body: string;
      readonly scope: ReadonlyArray<SourceRef>;
    }
  | {
      readonly name: string;
      readonly kind: "structured";
      readonly schema: string;
      readonly data: unknown;
      readonly scope: ReadonlyArray<SourceRef>;
    }
  | {
      readonly name: string;
      readonly kind: "stream";
      readonly chunks: ReadonlyArray<string>;
      readonly scope: ReadonlyArray<SourceRef>;
    };

export type ViewRunDocument =
  | {
      readonly schema: typeof VIEW_RUN_SCHEMA;
      readonly status: "ok";
      readonly command: string;
      readonly views: ReadonlyArray<RenderedPluginView>;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | {
      readonly schema: typeof VIEW_RUN_SCHEMA;
      readonly status: "error";
      readonly command: string;
      readonly error: string;
      readonly message: string;
      readonly installed?: ReadonlyArray<string>;
      readonly details?: unknown;
    };

export async function runInstalledView(
  vault: Vault,
  command: string,
  input: unknown = {},
): Promise<ViewRunDocument> {
  const installed = vault.listViews();
  if (!installed.some((view) => view.command === command)) {
    return {
      schema: VIEW_RUN_SCHEMA,
      status: "error",
      command,
      error: "view-not-found",
      message: `No installed plugin contributes the '${command}' view.`,
      installed: installed.map((view) => view.command),
    };
  }

  const result = await vault.runView(command, input);
  if (result.kind !== "ok") {
    return {
      schema: VIEW_RUN_SCHEMA,
      status: "error",
      command,
      error: result.kind,
      message: `The '${command}' view could not run (${result.kind}).`,
      details: result,
    };
  }

  const views: RenderedPluginView[] = [];
  for (const view of result.views) {
    switch (view.content.kind) {
      case "markdown":
        views.push({
          name: view.name,
          kind: "markdown",
          body: view.content.body,
          scope: view.scope,
        });
        break;
      case "structured":
        views.push({
          name: view.name,
          kind: "structured",
          schema: view.content.schema,
          data: view.content.data,
          scope: view.scope,
        });
        break;
      case "stream": {
        const chunks: string[] = [];
        for await (const chunk of view.content.chunks) chunks.push(chunk);
        views.push({
          name: view.name,
          kind: "stream",
          chunks,
          scope: view.scope,
        });
        break;
      }
    }
  }

  return {
    schema: VIEW_RUN_SCHEMA,
    status: "ok",
    command,
    views,
    brokerDiagnostics: result.brokerDiagnostics,
  };
}

export function viewRunStatus(document: ViewRunDocument): number {
  if (document.status === "ok") return 200;
  switch (document.error) {
    case "view-not-found":
      return 404;
    case "detached-head":
    case "missing-adopted-ref":
      return 409;
    case "adopted-ref-unstable":
      return 503;
    default:
      return 500;
  }
}
