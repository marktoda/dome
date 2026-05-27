import chokidar, { type FSWatcher } from "chokidar";
import { join, relative } from "node:path";
import type { HookEvent } from "./hooks/hook-context";

export interface OOBEvent extends HookEvent {
  kind: "vault.out-of-band-edit";
  path: string;
  fsKind: "created" | "modified" | "deleted";
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private vaultPath: string,
    private onEvent: (event: OOBEvent) => void
  ) {}

  async start(): Promise<void> {
    const targets = [
      join(this.vaultPath, "wiki"),
      join(this.vaultPath, "inbox"),
      join(this.vaultPath, "raw"),
      join(this.vaultPath, "notes"),
    ];
    const watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      ignored: (path: string) => path.includes("/.git/") || path.includes("/.dome/"),
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    watcher.on("add", (p: string) => this.fire(p, "created"));
    watcher.on("change", (p: string) => this.fire(p, "modified"));
    watcher.on("unlink", (p: string) => this.fire(p, "deleted"));
    this.watcher = watcher;
    // Wait for chokidar to finish its initial scan before returning;
    // otherwise file writes that race the ready event are lost.
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
  }

  private fire(absPath: string, fsKind: OOBEvent["fsKind"]): void {
    const rel = relative(this.vaultPath, absPath);
    this.onEvent({ kind: "vault.out-of-band-edit", path: rel, fsKind });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
