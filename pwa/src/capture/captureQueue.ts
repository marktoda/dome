import type { CaptureReceipt, CaptureRequest } from "../../../contracts/capture";

export type CaptureQueueState = "saved-locally" | "failed";

export type QueuedCapture = {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  readonly createdAt: string;
  /** Null only for captures saved before a validated readiness document existed. */
  readonly vaultId: string | null;
  readonly state: CaptureQueueState;
  readonly attempts: number;
  readonly lastError?: string;
};

export type CaptureQueueDeps = {
  readonly now?: () => Date;
  readonly randomId?: () => string;
};

export type CaptureDrainResult = {
  readonly id: string;
  readonly text: string;
  readonly receipt: Exclude<CaptureReceipt, { readonly status: "error" }>;
};

const DB = "dome-pwa";
const STORE = "captures";

/** Durable browser outbox. Only queued/failed plaintext persists. */
export class CaptureQueue {
  private activeDrain: Promise<CaptureDrainResult[]> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async save(
    input: Omit<CaptureRequest, "captureId">,
    vaultId: string | null,
    deps: CaptureQueueDeps = {},
  ): Promise<QueuedCapture> {
    const text = input.text.trim();
    if (text.length === 0) throw new Error("empty capture");
    if (vaultId !== null) requireVaultId(vaultId);
    const item: QueuedCapture = {
      id: (deps.randomId ?? defaultRandomId)(),
      text,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      vaultId,
      state: "saved-locally",
      attempts: 0,
    };
    await this.put(item);
    return item;
  }

  async all(): Promise<QueuedCapture[]> {
    const rows = await this.tx<Array<QueuedCapture | LegacyQueuedCapture>>("readonly", (s) =>
      s.getAll() as IDBRequest<Array<QueuedCapture | LegacyQueuedCapture>>,
    );
    const normalized = rows.map(normalizeStoredCapture);
    const changed = normalized.filter((item, index) => item !== rows[index]);
    if (changed.length > 0) {
      for (const item of changed) await this.put(item);
    }
    return normalized.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async remove(id: string): Promise<void> {
    await this.deleteStored(id);
  }

  /** Explicitly attach one legacy unbound row to the currently validated vault. */
  async bind(id: string, vaultId: string): Promise<boolean> {
    requireVaultId(vaultId);
    return await this.bindIfUnbound(id, vaultId);
  }

  async drain(
    vaultId: string,
    send: (request: CaptureRequest) => Promise<CaptureReceipt>,
  ): Promise<CaptureDrainResult[]> {
    requireVaultId(vaultId);
    if (this.activeDrain !== null) return this.activeDrain;
    this.activeDrain = this.drainOnce(vaultId, send).finally(() => {
      this.activeDrain = null;
    });
    return this.activeDrain;
  }

  private async drainOnce(
    vaultId: string,
    send: (request: CaptureRequest) => Promise<CaptureReceipt>,
  ): Promise<CaptureDrainResult[]> {
    const completed: CaptureDrainResult[] = [];
    for (const item of await this.all()) {
      if (item.vaultId !== vaultId) continue;
      if (!await this.isPresent(item.id)) continue;
      try {
        const receipt = await send({
          text: item.text,
          ...(item.title !== undefined ? { title: item.title } : {}),
          captureId: item.id,
        });
        if (receipt.status === "error") {
          throw new Error(receipt.error);
        }
        if (receipt.vault !== vaultId || receipt.capture_id !== item.id) {
          throw new Error("capture receipt did not match the queued vault and capture identity");
        }
        await this.deleteStored(item.id);
        completed.push({ id: item.id, text: item.text, receipt });
      } catch (error) {
        await this.putIfPresent(item.id, {
          ...item,
          state: "failed",
          attempts: item.attempts + 1,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return completed;
  }

  async exportJson(): Promise<string> {
    return JSON.stringify({
      schema: "dome.capture-queue/v1",
      exported_at: new Date().toISOString(),
      captures: await this.all(),
    }, null, 2);
  }

  private put(item: QueuedCapture): Promise<void> {
    return this.tx("readwrite", (s) => s.put(item)).then(() => undefined);
  }

  private deleteStored(id: string): Promise<void> {
    return this.tx("readwrite", (s) => s.delete(id)).then(() => undefined);
  }

  private async isPresent(id: string): Promise<boolean> {
    return (await this.tx<QueuedCapture | LegacyQueuedCapture | undefined>(
      "readonly",
      (s) => s.get(id) as IDBRequest<QueuedCapture | LegacyQueuedCapture | undefined>,
    )) !== undefined;
  }

  /**
   * Failure settlement and local deletion may race across tabs. Keeping the
   * existence check and failure write in one IndexedDB transaction lets the
   * database serialize both outcomes: a completed delete is never recreated,
   * while a failed or later delete leaves/removes the failed row normally.
   */
  private async putIfPresent(id: string, item: QueuedCapture): Promise<boolean> {
    const db = await this.open();
    return new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id) as IDBRequest<QueuedCapture | undefined>;
      let present = false;
      request.onsuccess = () => {
        if (request.result !== undefined) {
          present = true;
          store.put(item);
        }
      };
      request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
      transaction.oncomplete = () => {
        db.close();
        resolve(present);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error("indexeddb transaction failed"));
      };
      transaction.onabort = transaction.onerror;
    });
  }

  /** The unbound check and write share one transaction so another tab cannot rebind a row. */
  private async bindIfUnbound(id: string, vaultId: string): Promise<boolean> {
    const db = await this.open();
    return new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id) as IDBRequest<QueuedCapture | LegacyQueuedCapture | undefined>;
      let bound = false;
      request.onsuccess = () => {
        if (request.result === undefined) return;
        const current = normalizeStoredCapture(request.result);
        if (current.vaultId !== null) return;
        bound = true;
        store.put({ ...current, vaultId });
      };
      request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
      transaction.oncomplete = () => {
        db.close();
        resolve(bound);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error("indexeddb transaction failed"));
      };
      transaction.onabort = transaction.onerror;
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = this.factory.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
    });
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = fn(transaction.objectStore(STORE));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
      transaction.oncomplete = () => {
        db.close();
        resolve(result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error("indexeddb transaction failed"));
      };
      transaction.onabort = transaction.onerror;
    });
  }
}

type LegacyQueuedCapture = Omit<QueuedCapture, "vaultId" | "state"> & {
  readonly vaultId?: string | null;
  readonly state: CaptureQueueState | "sending";
};

function normalizeStoredCapture(item: QueuedCapture | LegacyQueuedCapture): QueuedCapture {
  const vaultId = "vaultId" in item && typeof item.vaultId === "string"
    ? item.vaultId
    : null;
  const state = item.state === "sending" ? "saved-locally" : item.state;
  if (vaultId === item.vaultId && state === item.state) return item as QueuedCapture;
  return {
    ...item,
    vaultId,
    state,
    ...(state === "saved-locally" ? { lastError: undefined } : {}),
  };
}

function requireVaultId(vaultId: string): void {
  if (
    vaultId.length === 0 || vaultId.length > 4096 || vaultId.includes("\0") ||
    /[\r\n]/.test(vaultId)
  ) {
    throw new Error("invalid capture vault identity");
  }
}

function defaultRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  throw new Error("secure capture identity is unavailable");
}
