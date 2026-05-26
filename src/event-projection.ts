// Projects Tool `Effect`s into `HookEvent`s. Path classification (which
// `category` a path lives in, which wiki `type` etc.) is delegated to
// `makeDocument` — the single source of truth in `src/document.ts`. The
// only event-specific work this module does is mapping a Document's
// category+type to a hook-event kind, plus the inbox-bucket extraction
// (which isn't represented on Document, since buckets are an inbox-only
// dimension).

import type { Effect } from "./types";
import type { HookEvent } from "./hook-context";
import { makeDocument, type Document } from "./document";
import { singularOf } from "./page-type";

function inboxBucket(path: string): string | null {
  const segments = path.split("/");
  return segments.length >= 3 && segments[0] === "inbox" ? segments[1]! : null;
}

function writtenEventFor(doc: Document, diff: string): HookEvent[] {
  const { path, category, type } = doc;
  if (category === "index") return [{ kind: "document.written.index", path, diff }];
  if (category === "log") return [{ kind: "document.written.log", path, diff }];
  if (category === "wiki" && type !== null) {
    const singular = singularOf(type);
    return [{ kind: `document.written.wiki.${singular}`, path, category: "wiki", type: singular, diff }];
  }
  if (category === "inbox") {
    const bucket = inboxBucket(path);
    if (bucket !== null) {
      return [{ kind: `document.written.inbox.${bucket}`, path, category: "inbox", bucket, diff }];
    }
  }
  if (category === "raw") return [{ kind: "document.written.raw", path, category: "raw", diff }];
  // notes/ and external are OOB-only per matrix; the dispatcher does NOT emit content events.
  return [];
}

function deletedEventFor(doc: Document): HookEvent[] {
  const { path, category, type } = doc;
  if (category === "index") return [{ kind: "document.deleted.index", path }];
  if (category === "log") return [{ kind: "document.deleted.log", path }];
  if (category === "wiki" && type !== null) {
    const singular = singularOf(type);
    return [{ kind: `document.deleted.wiki.${singular}`, path, category: "wiki", type: singular }];
  }
  if (category === "inbox") {
    const bucket = inboxBucket(path);
    if (bucket !== null) {
      return [{ kind: `document.deleted.inbox.${bucket}`, path, category: "inbox", bucket }];
    }
  }
  if (category === "raw") return [{ kind: "document.deleted.raw", path, category: "raw" }];
  return [];
}

export function projectEffectToEvents(effect: Effect): HookEvent[] {
  switch (effect.kind) {
    case "wrote-document":
      return writtenEventFor(makeDocument({ path: effect.path }), effect.diff);
    case "appended-log":
      return [{ kind: "log.appended", entry: effect.entry, ts: effect.entry.ts }];
    case "moved-document":
      return [{ kind: "document.moved", from: effect.from, to: effect.to }];
    case "deleted-document":
      return deletedEventFor(makeDocument({ path: effect.path }));
  }
}

export function projectEffectsToEvents(effects: ReadonlyArray<Effect>): HookEvent[] {
  return effects.flatMap(projectEffectToEvents);
}
