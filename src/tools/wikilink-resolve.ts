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
  if (!out.result.ok) {
    if (out.result.error.kind === "not-found") {
      return { result: ok(null), effects: [] };
    }
    return { result: ok(null), effects: [] };
  }
  return { result: ok(out.result.value), effects: [] };
}
