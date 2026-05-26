import type { Effect } from "./types";
import type { HookEvent } from "./hook-context";
import { singularOf } from "./page-type";

export function projectEffectToEvents(effect: Effect): HookEvent[] {
  switch (effect.kind) {
    case "wrote-document": {
      const { path, diff } = effect;
      // Root special files first.
      if (path === "index.md") return [{ kind: "document.written.index", path, diff }];
      if (path === "log.md") return [{ kind: "document.written.log", path, diff }];

      const segments = path.split("/");
      const top = segments[0];
      if (top === "wiki" && segments.length >= 3) {
        const pluralType = segments[1]!;
        const singular = singularOf(pluralType);
        return [{ kind: `document.written.wiki.${singular}`, path, category: "wiki", type: singular, diff }];
      }
      if (top === "inbox" && segments.length >= 3) {
        const bucket = segments[1]!;
        return [{ kind: `document.written.inbox.${bucket}`, path, category: "inbox", bucket, diff }];
      }
      if (top === "raw") {
        return [{ kind: "document.written.raw", path, category: "raw", diff }];
      }
      // notes/ and external are OOB-only per matrix; the dispatcher does NOT emit content events.
      return [];
    }
    case "appended-log":
      return [{ kind: "log.appended", entry: effect.entry, ts: effect.entry.ts }];
    case "moved-document":
      return [{ kind: "document.moved", from: effect.from, to: effect.to }];
    case "deleted-document": {
      const { path } = effect;
      if (path === "index.md") return [{ kind: "document.deleted.index", path }];
      if (path === "log.md") return [{ kind: "document.deleted.log", path }];
      const segments = path.split("/");
      const top = segments[0];
      if (top === "wiki" && segments.length >= 3) {
        const pluralType = segments[1]!;
        const singular = singularOf(pluralType);
        return [{ kind: `document.deleted.wiki.${singular}`, path, category: "wiki", type: singular }];
      }
      if (top === "inbox" && segments.length >= 3) {
        const bucket = segments[1]!;
        return [{ kind: `document.deleted.inbox.${bucket}`, path, category: "inbox", bucket }];
      }
      if (top === "raw") {
        return [{ kind: "document.deleted.raw", path, category: "raw" }];
      }
      return [];
    }
  }
}

export function projectEffectsToEvents(effects: ReadonlyArray<Effect>): HookEvent[] {
  return effects.flatMap(projectEffectToEvents);
}
