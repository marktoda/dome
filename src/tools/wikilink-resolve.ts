import { readDocument } from "./read-document";
import { isFullPathLink } from "../wikilinks";
import { ok, type ToolReturn } from "../types";
import type { Document } from "../document";
import type { Vault } from "../vault";

export interface WikilinkResolveInput {
  link: string;
}

export async function wikilinkResolve(
  vault: Vault,
  input: WikilinkResolveInput
): Promise<ToolReturn<Document | null>> {
  if (!isFullPathLink(input.link)) {
    return { result: ok(null), effects: [] };
  }
  const path = input.link.endsWith(".md") ? input.link : `${input.link}.md`;
  const out = await readDocument(vault, { path });
  // Any failure to read (not-found, parse error, etc) resolves to null —
  // wikilinkResolve never propagates errors; it's strictly a yes/no surface.
  return { result: ok(out.result.ok ? out.result.value : null), effects: [] };
}
