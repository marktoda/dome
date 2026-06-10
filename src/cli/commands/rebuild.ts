// cli/commands/rebuild: rebuild projection.db from the adopted commit.
//
// Thin printer over the public wrapper: `openVault` + `vault.rebuild()`
// own the precondition checks (branch, adopted ref) and the engine
// delegation; this file owns argv → options and outcome → terminal.

import { basename } from "node:path";

import { openVault, type OpenVaultError } from "../../vault";
import { formatJson } from "../format";
import {
  footer,
  headline,
  kv,
  resolveCaps,
  section,
} from "../presenter";

import { resolveVaultPath } from "../resolve-vault";
export type RunRebuildOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

type RebuildJsonResult =
  | {
      readonly schema: "dome.rebuild/v1";
      readonly status: "rebuilt";
      readonly branch: string;
      readonly adopted: string;
      readonly files: number;
      readonly processors: number;
      readonly effects: number;
    }
  | {
      readonly schema: "dome.rebuild/v1";
      readonly status: "error";
      readonly branch: string | null;
      readonly adopted: string | null;
      readonly error: string;
    };

export async function runRebuild(
  options: RunRebuildOptions = {},
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const jsonMode = options.json === true;

  const opened = await openVault({
    path: vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  if (!opened.ok) {
    return emitError({
      jsonMode,
      branch: null,
      adopted: null,
      error: openErrorKind(opened.error),
      message:
        opened.error.kind === "not-a-vault"
          ? `dome rebuild: ${opened.error.message}`
          : `dome rebuild: openVaultRuntime failed (${opened.error.cause.kind}). ` +
            "Run `dome init` to initialize the vault.",
    });
  }

  const vault = opened.value;
  try {
    const outcome = await vault.rebuild();
    switch (outcome.kind) {
      case "detached-head":
        return emitError({
          jsonMode,
          branch: null,
          adopted: null,
          error: "detached-head",
          message:
            `dome rebuild: HEAD is detached at ${vaultPath}. ` +
            "Check out a branch and retry.",
        });
      case "missing-adopted-ref":
        return emitError({
          jsonMode,
          branch: outcome.branch,
          adopted: null,
          error: "adopted-ref-uninitialized",
          message:
            `dome rebuild: adopted ref for ${outcome.branch} is uninitialized. Run \`dome sync\` first.`,
        });
      case "ok":
        if (jsonMode) {
          const payload: RebuildJsonResult = {
            schema: "dome.rebuild/v1",
            status: "rebuilt",
            branch: outcome.branch,
            adopted: outcome.adopted,
            files: outcome.files,
            processors: outcome.processors,
            effects: outcome.effects,
          };
          console.log(formatJson(payload));
        } else {
          printRebuildText({
            vaultPath,
            branch: outcome.branch,
            adopted: outcome.adopted,
            files: outcome.files,
            processors: outcome.processors,
            effects: outcome.effects,
          });
        }
        return 0;
    }
  } finally {
    await vault.close();
  }
}

function openErrorKind(error: OpenVaultError): string {
  return error.kind === "runtime-open-failed" ? error.cause.kind : error.kind;
}

function printRebuildText(result: {
  readonly vaultPath: string;
  readonly branch: string;
  readonly adopted: string;
  readonly files: number;
  readonly processors: number;
  readonly effects: number;
}): void {
  const caps = resolveCaps();
  const lines: string[] = [
    headline(
      { cmd: "rebuild", context: basename(result.vaultPath) },
      { tone: "ok", label: "rebuilt" },
      caps,
    ),
  ];
  lines.push(
    ...section(
      "Projection",
      kv(
        [
          { label: "branch", value: result.branch },
          { label: "adopted", value: result.adopted.slice(0, 7), tone: "ident" },
          { label: "files scanned", value: String(result.files) },
          { label: "processors run", value: String(result.processors) },
          { label: "effects recorded", value: String(result.effects) },
        ],
        caps,
      ),
      caps,
    ),
  );
  lines.push(...footer({ tone: "ok", label: "rebuilt" }, caps));
  console.log(lines.join("\n"));
}

function emitError(opts: {
  readonly jsonMode: boolean;
  readonly branch: string | null;
  readonly adopted: string | null;
  readonly error: string;
  readonly message: string;
}): number {
  if (opts.jsonMode) {
    const payload: RebuildJsonResult = {
      schema: "dome.rebuild/v1",
      status: "error",
      branch: opts.branch,
      adopted: opts.adopted,
      error: opts.error,
    };
    console.log(formatJson(payload));
  } else {
    console.error(opts.message);
  }
  return opts.error === "detached-head" || opts.error === "adopted-ref-uninitialized"
    ? 64
    : 1;
}
