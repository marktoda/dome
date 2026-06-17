export type QueuedCapture = { id: string; text: string; title?: string };

const DB = "dome-pwa";
const STORE = "captures";

export class CaptureQueue {
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = this.factory.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb tx failed"));
      t.oncomplete = () => db.close();
    });
  }

  async enqueue(c: QueuedCapture): Promise<void> { await this.tx("readwrite", (s) => s.put(c)); }
  async all(): Promise<QueuedCapture[]> { return (await this.tx<QueuedCapture[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedCapture[]>)); }
  async remove(id: string): Promise<void> { await this.tx("readwrite", (s) => s.delete(id)); }
}
