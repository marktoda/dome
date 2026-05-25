import type { HookHandler } from "../hook-context";
import { basename } from "node:path";

export const autoUpdateIndex: HookHandler = async (event, ctx) => {
  if (!ctx.dispatcher) return; // privileged API only available to built-in handlers
  const path = event.path;
  if (typeof path !== "string") return;
  const title = titleFromPath(path);
  await ctx.dispatcher.writeIndex({ path, title });
};

function titleFromPath(path: string): string {
  const base = basename(path).replace(/\.md$/, "");
  return base.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
