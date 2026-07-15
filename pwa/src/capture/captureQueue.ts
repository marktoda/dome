import type { CaptureReceipt, CaptureRequest } from "../../../contracts/capture";

export type CaptureQueueState = "saved-locally" | "sending" | "failed";

export type QueuedCapture = {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  readonly createdAt: string;
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
  readonly receipt: CaptureReceipt;
};

const DB = "dome-pwa";
const STORE = "captures";

/** Durable browser outbox. Items leave only after a committed/duplicate receipt. */
export class CaptureQueue {
  private activeDrain: Promise<CaptureDrainResult[]> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async save(
    input: Omit<CaptureRequest, "captureId">,
    deps: CaptureQueueDeps = {},
  ): Promise<QueuedCapture> {
    const text = input.text.trim();
    if (text.length === 0) throw new Error("empty capture");
    const item: QueuedCapture = {
      id: (deps.randomId ?? defaultRandomId)(),
      text,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      state: "saved-locally",
      attempts: 0,
    };
    await this.put(item);
    return item;
  }

  async all(): Promise<QueuedCapture[]> {
    const rows = await this.tx<QueuedCapture[]>("readonly", (s) =>
      s.getAll() as IDBRequest<QueuedCapture[]>,
    );
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async remove(id: string): Promise<void> {
    await this.deleteStored(id);
  }

  async drain(
    send: (request: CaptureRequest) => Promise<CaptureReceipt>,
  ): Promise<CaptureDrainResult[]> {
    if (this.activeDrain !== null) return this.activeDrain;
    this.activeDrain = this.drainOnce(send).finally(() => {
      this.activeDrain = null;
    });
    return this.activeDrain;
  }

  private async drainOnce(
    send: (request: CaptureRequest) => Promise<CaptureReceipt>,
  ): Promise<CaptureDrainResult[]> {
    const completed: CaptureDrainResult[] = [];
    for (const item of await this.all()) {
      const sending: QueuedCapture = {
        ...item,
        state: "sending",
        attempts: item.attempts + 1,
        lastError: undefined,
      };
      if (!await this.putIfPresent(item.id, sending)) continue;
      try {
        const receipt = await send({
          text: item.text,
          ...(item.title !== undefined ? { title: item.title } : {}),
          captureId: item.id,
        });
        if (receipt.status === "error") {
          throw new Error(receipt.error);
        }
        await this.deleteStored(item.id);
        completed.push({ id: item.id, receipt });
      } catch (error) {
        await this.putIfPresent(item.id, {
          ...sending,
          state: "failed",
          lastError: error instanceof Error ? error.message : String(error),
        });
        break;
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

function defaultRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  throw new Error("secure capture identity is unavailable");
}
